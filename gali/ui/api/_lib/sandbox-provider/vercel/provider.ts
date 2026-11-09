// A Vercel sandbox is named and persistent: stopping it snapshots the disk and
// resuming boots a fresh VM from that snapshot, so every wake is cold. The
// name is the home and the sandbox id, which keeps the URL and the server's
// HMAC stable across sessions. User data lives on a Drive capped at
// HOME_DRIVE_BYTES and mounted at /gali-data; the root disk is the image.

import { APIError, Drive, Sandbox, type NetworkPolicy, type Session } from "@vercel/sandbox";
import {
  SandboxCommandError,
  SandboxFileNotFoundError,
  SandboxUnavailableError,
  type LiveSandbox,
  type SandboxProvider,
  type WokenSandbox,
} from "../types.js";

// No session runs past an hour, busy or not. Idle sleep, driven from inside by
// the Gali server, usually stops it sooner. The timeout is stored on the
// sandbox at create and reused by every resume, so changing it here does not
// reach existing homes: set those with `vercel sandbox config timeout`.
const MAX_AWAKE_MS = 60 * 60_000;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
const VCPUS = 2;
export const HOME_DRIVE_BYTES = 1024 ** 3;
const DATA_DIR = "/gali-data";
const GALI_PORT = 8787;

// Egress is checked by SNI. github.com is left out on purpose: it accepts
// pushes, codeload only serves archives.
const STANDING_HOSTS = ["pypi.org", "files.pythonhosted.org", "codeload.github.com"];

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export function standingEgress(): string[] {
  const hosts = [new URL(requireEnv("GALI_MODEL_GATEWAY_URL")).hostname, ...STANDING_HOSTS];
  const sleepUrl = process.env.GALI_SLEEP_URL?.trim();
  if (sleepUrl) hosts.push(new URL(sleepUrl).hostname);
  return [...new Set(hosts)];
}

function policy(extra: readonly string[] = []): NetworkPolicy {
  return { allow: [...new Set([...standingEgress(), ...extra])] };
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof APIError && error.response.status === status;
}

// Every call goes to the session the handle was built with, never through the
// Sandbox wrapper: the wrapper resumes a stopped persistent sandbox on any
// command, and only wake may bring a home up.
export function vercelSandbox(name: string, session: Session): LiveSandbox {
  return {
    id: name,
    url: (port) => session.domain(port),
    async run(script, options = {}) {
      const cmd = await session.runCommand({
        cmd: "bash",
        args: ["-lc", script],
        env: options.env,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
      });
      const output = await cmd.output("both");
      if (cmd.exitCode !== 0) throw new SandboxCommandError(script, cmd.exitCode, output);
      return output;
    },
    // No timeoutMs: on expiry it SIGKILLs the process, which must outlive this call.
    async spawn(script, options = {}) {
      await session.runCommand({ cmd: "bash", args: ["-lc", script], env: options.env, cwd: options.cwd, detached: true });
    },
    async readFile(path) {
      const contents = await session.readFileToBuffer({ path });
      if (contents === null) throw new SandboxFileNotFoundError(path);
      return contents.toString("utf8");
    },
    async writeFile(path, contents) {
      await session.writeFiles([{ path, content: typeof contents === "string" ? Buffer.from(contents) : contents }]);
    },
    async withEgress(hosts, work) {
      await session.update({ networkPolicy: policy(hosts) });
      try {
        return await work();
      } finally {
        await session.update({ networkPolicy: policy() });
      }
    },
  };
}

function homeMissing(error: unknown): unknown {
  if (isStatus(error, 404)) {
    return new SandboxUnavailableError({
      kind: "home_missing",
      provider: "vercel",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return error;
}

async function create(owner: string): Promise<WokenSandbox> {
  const name = `${owner}-${Date.now().toString(36)}`;
  const drive = await Drive.getOrCreate({ name, maxSize: HOME_DRIVE_BYTES });
  const sbx = await Sandbox.create({
    name,
    image: requireEnv("GALI_SANDBOX_IMAGE"),
    ports: [GALI_PORT],
    resources: { vcpus: VCPUS },
    timeout: MAX_AWAKE_MS,
    persistent: true,
    // An expired snapshot recreates the sandbox empty: the user's install gone.
    snapshotExpiration: 0,
    keepLastSnapshots: { count: 1 },
    networkPolicy: policy(),
    mounts: { [DATA_DIR]: drive },
    tags: { app: "gali", owner },
  });
  return { home: name, sandbox: vercelSandbox(name, sbx.currentSession()), boot: "cold" };
}

// The policy is reapplied on every wake so a change to the allow-list reaches
// homes created before it.
async function wake(home: string | null, owner: string): Promise<WokenSandbox> {
  if (!home) return create(owner);
  const sbx = await Sandbox.get({ name: home, resume: true }).catch((error: unknown) => {
    throw homeMissing(error);
  });
  const session = sbx.currentSession();
  await session.update({ networkPolicy: policy() });
  return { home, sandbox: vercelSandbox(home, session), boot: "cold" };
}

async function attach(sandboxId: string): Promise<LiveSandbox | null> {
  try {
    const sbx = await Sandbox.get({ name: sandboxId });
    if (sbx.status !== "running") return null;
    return vercelSandbox(sandboxId, sbx.currentSession());
  } catch (error) {
    if (isStatus(error, 404)) return null;
    throw error;
  }
}

const STOPPED = new Set(["stopping", "stopped", "snapshotting", "failed", "aborted"]);

async function sleep(home: string): Promise<void> {
  const sbx = await Sandbox.get({ name: home });
  if (!STOPPED.has(sbx.status)) await sbx.currentSession().stop();
}

// The Drive can only be deleted once no sandbox has it mounted.
async function destroy(home: string): Promise<void> {
  const sbx = await Sandbox.get({ name: home }).catch((error: unknown) => {
    if (isStatus(error, 404)) return null;
    throw error;
  });
  if (sbx) {
    if (!STOPPED.has(sbx.status)) await sbx.currentSession().stop();
    await sbx.delete({ deleteOrphanSnapshots: true });
  }
  const drive = await Drive.get({ name: home }).catch((error: unknown) => {
    if (isStatus(error, 404)) return null;
    throw error;
  });
  if (drive) await drive.delete();
}

export const vercelProvider: SandboxProvider = {
  kind: "vercel",
  maxAwakeMs: MAX_AWAKE_MS,
  keepsMemoryOnSleep: false,
  wake,
  attach,
  sleep,
  destroy,
};
