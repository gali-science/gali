import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { AGENT_USER, agentIdentity } from "./agent-user.js";

const KILL_GRACE_MS = 5_000;

export type AppServerNotification = { method: string; params: Record<string, unknown> };

export type AppServerClient = {
  request<T>(method: string, params: unknown): Promise<T>;
  close(): Promise<void>;
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string };

function codexBin(): string {
  const require = createRequire(import.meta.url);
  return path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}

/** `codex app-server` over stdio: JSON-RPC lines without the "jsonrpc" field. */
export async function startAppServer(opts: {
  args: string[];
  env: Record<string, string>;
  onNotification: (notification: AppServerNotification) => void;
  onExit: (error: Error) => void;
}): Promise<AppServerClient> {
  const agent = agentIdentity();
  const child = spawn(process.execPath, [codexBin(), "app-server", ...opts.args], {
    env: agent ? { ...opts.env, HOME: agent.home, USER: AGENT_USER, LOGNAME: AGENT_USER } : opts.env,
    ...(agent ? { uid: agent.uid, gid: agent.gid } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let closing = false;
  let exitError: Error | null = null;
  const exited = new Promise<void>((resolve) => {
    const finish = (error: Error) => {
      if (exitError) return;
      exitError = error;
      for (const call of pending.values()) call.reject(error);
      pending.clear();
      if (!closing) opts.onExit(error);
      resolve();
    };
    child.on("exit", (code, signal) => finish(new Error(`codex app-server exited (${signal ?? `code ${code}`})`)));
    child.on("error", finish);
  });

  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);

  createInterface({ input: child.stderr }).on("line", (line) => console.warn(`[codex] ${line}`));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as {
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.method === undefined) {
      const call = pending.get(Number(message.id));
      if (!call) return;
      pending.delete(Number(message.id));
      if (message.error) call.reject(new Error(`${call.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      else call.resolve(message.result);
    } else if (message.id !== undefined) {
      // Approvals are off, so Codex has nothing legitimate to ask us.
      send({ id: message.id, error: { code: -32601, message: `${message.method} is not supported` } });
    } else {
      opts.onNotification({ method: message.method, params: message.params ?? {} });
    }
  });

  const client: AppServerClient = {
    request<T>(method: string, params: unknown): Promise<T> {
      if (exitError) return Promise.reject(exitError);
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject, method });
        send({ id, method, params });
      });
    },
    async close() {
      if (exitError) return;
      closing = true;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      await exited;
      clearTimeout(timer);
    },
  };

  try {
    await client.request("initialize", {
      clientInfo: { name: "gali", title: "Gali", version: "1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
  } catch (error) {
    await client.close();
    throw error;
  }
  send({ method: "initialized" });
  return client;
}
