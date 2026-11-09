import type {
  AgentProvider,
  ExecutionPolicy,
  ProviderSession,
  ProviderTurnEvent,
  SubagentEvent,
} from "../../core/types.js";
import { startAppServer, type AppServerNotification } from "./app-server-client.js";
import { mapCodexItem, type CodexItem } from "./codex-events.js";

const PROVIDER_ID = "gali_model";
const TOKEN_ENV = "CODEX_API_KEY";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
// The v2 thread cap counts the root thread: 2 = Leo plus one subagent.
const MAX_THREADS = 2;
const EXIT = "gali/exit";

export type CodexCredentials =
  | { kind: "gateway"; baseUrl: string; token: string; model: string }
  | { kind: "apiKey"; apiKey: string; model: string };

type Turn = { id: string; status: "completed" | "interrupted" | "failed" | "inProgress"; error: { message: string } | null };
type Thread = { id: string };

function toml(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** `-c key=value` overrides for `codex app-server`. */
export function codexConfigArgs(credentials: CodexCredentials): string[] {
  // app-server reads no API key from the environment for the built-in OpenAI
  // provider, so both credentials go through a custom provider with env_key.
  // The gateway runs on Vercel, which cannot upgrade wss:// /v1/responses.
  const provider = credentials.kind === "gateway"
    ? { name: "Gali", base_url: credentials.baseUrl, wire_api: "responses", env_key: TOKEN_ENV, supports_websockets: false }
    : { name: "OpenAI", base_url: OPENAI_BASE_URL, wire_api: "responses", env_key: TOKEN_ENV };
  const config: Record<string, string | number | boolean> = {
    "features.multi_agent_v2.enabled": true,
    "features.multi_agent_v2.max_concurrent_threads_per_session": MAX_THREADS,
    // A goal keeps the thread running turns Gali never started, so nothing tracks them.
    "features.goals": false,
    "sandbox_workspace_write.network_access": true,
    web_search: "live",
    model_provider: PROVIDER_ID,
    ...Object.fromEntries(Object.entries(provider).map(([key, value]) => [`model_providers.${PROVIDER_ID}.${key}`, value])),
  };
  return Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]);
}

function threadParams(policy: ExecutionPolicy, model: string) {
  return { cwd: policy.workingDirectory, sandbox: "workspace-write", approvalPolicy: "never", model };
}

function subagentStatus(turn: Turn): Extract<SubagentEvent, { type: "subagent.finished" }>["status"] {
  return turn.status === "completed" || turn.status === "interrupted" ? turn.status : "failed";
}

export function createCodexProvider(credentials: CodexCredentials): AgentProvider {
  return {
    async open({ threadId, policy, onSubagent, onSubagentStep, onExit }): Promise<ProviderSession> {
      const listeners = new Set<(notification: AppServerNotification) => void>();
      const children = new Map<string, { turnId: string | null; running: boolean; lastMessage: string }>();
      let leo: string | null = null;

      // Turns seen on other threads, in case one starts before Leo's spawn item names it.
      const otherTurns = new Map<string, string>();

      const trackSubagents = ({ method, params }: AppServerNotification) => {
        const threadId = params.threadId as string | undefined;
        // app-server sends no thread/started for a spawned subagent; Leo's
        // subAgentActivity item is what names the child thread.
        if (threadId === leo && (method === "item/started" || method === "item/completed")) {
          const item = params.item as CodexItem & { kind?: string; agentThreadId?: string };
          if (item.type !== "subAgentActivity" || item.kind !== "started" || !item.agentThreadId) return;
          if (children.has(item.agentThreadId)) return;
          children.set(item.agentThreadId, { turnId: otherTurns.get(item.agentThreadId) ?? null, running: true, lastMessage: "" });
          onSubagent({ type: "subagent.started", threadId: item.agentThreadId });
          return;
        }
        if (threadId === undefined || threadId === leo) return;
        if (method === "turn/started") otherTurns.set(threadId, (params.turn as Turn).id);
        const child = children.get(threadId);
        if (!child) return;
        if (method === "turn/started") {
          child.turnId = (params.turn as Turn).id;
          child.running = true;
        } else if (method === "item/completed") {
          const step = mapCodexItem(params.item as CodexItem);
          if (step?.type === "message") child.lastMessage = step.text;
          if (step) onSubagentStep(step);
        } else if (method === "turn/completed") {
          const turn = params.turn as Turn;
          child.turnId = null;
          child.running = false;
          onSubagent({
            type: "subagent.finished",
            threadId: params.threadId as string,
            status: subagentStatus(turn),
            message: child.lastMessage || (turn.error?.message ?? ""),
          });
        } else if (method === "thread/closed") {
          children.delete(params.threadId as string);
        }
      };

      const token = credentials.kind === "gateway" ? credentials.token : credentials.apiKey;
      const client = await startAppServer({
        args: codexConfigArgs(credentials),
        env: { ...policy.env, [TOKEN_ENV]: token },
        onNotification: (notification) => {
          trackSubagents(notification);
          for (const listener of listeners) listener(notification);
        },
        onExit: (error) => {
          for (const [id, child] of children) {
            if (child.running) onSubagent({ type: "subagent.finished", threadId: id, status: "failed", message: error.message });
          }
          children.clear();
          for (const listener of listeners) listener({ method: EXIT, params: { error } });
          onExit(error);
        },
      });

      try {
        const params = threadParams(policy, credentials.model);
        const started = threadId
          ? await client.request<{ thread: Thread }>("thread/resume", { threadId, ...params, excludeTurns: true })
          : await client.request<{ thread: Thread }>("thread/start", params);
        leo = started.thread.id;
      } catch (error) {
        await client.close();
        throw error;
      }
      const leoId = leo;
      let activeTurn: string | null = null;

      return {
        id: leoId,

        async *run(input, { signal }): AsyncIterable<ProviderTurnEvent> {
          const queue: AppServerNotification[] = [];
          let wake: (() => void) | null = null;
          const listener = (notification: AppServerNotification) => {
            if (notification.method !== EXIT && notification.params.threadId !== leoId) return;
            queue.push(notification);
            wake?.();
          };
          listeners.add(listener);
          let interrupt: (() => void) | null = null;
          try {
            const { turn } = await client.request<{ turn: Turn }>("turn/start", {
              threadId: leoId,
              input: [{ type: "text", text: input, text_elements: [] }],
            });
            activeTurn = turn.id;
            interrupt = () => {
              client.request("turn/interrupt", { threadId: leoId, turnId: turn.id }).catch((error: unknown) => {
                console.warn(`[codex] interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
              });
            };
            if (signal.aborted) interrupt();
            else signal.addEventListener("abort", interrupt, { once: true });
            yield { type: "turn.started" };

            let finalResponse = "";
            for (;;) {
              while (queue.length === 0) {
                await new Promise<void>((resolve) => (wake = resolve));
                wake = null;
              }
              const { method, params } = queue.shift()!;
              if (method === EXIT) throw params.error as Error;
              if (method === "item/completed" && params.turnId === turn.id) {
                const item = params.item as CodexItem & { kind?: string };
                if (item.type === "subAgentActivity" && (item.kind === "started" || item.kind === "interacted")) {
                  yield { type: "handoff" };
                  continue;
                }
                const event = mapCodexItem(params.item as CodexItem);
                if (event?.type === "message") finalResponse = event.text;
                if (event) yield event;
              } else if (method === "turn/completed" && (params.turn as Turn).id === turn.id) {
                const done = params.turn as Turn;
                if (done.status === "completed") yield { type: "turn.completed", finalResponse };
                else yield { type: "turn.failed", error: done.error?.message ?? `the turn was ${done.status}` };
                return;
              }
            }
          } finally {
            activeTurn = null;
            listeners.delete(listener);
            if (interrupt) signal.removeEventListener("abort", interrupt);
          }
        },

        async steer(input) {
          const turnId = activeTurn;
          if (!turnId) return false;
          try {
            await client.request("turn/steer", {
              threadId: leoId,
              input: [{ type: "text", text: input, text_elements: [] }],
              expectedTurnId: turnId,
            });
            return true;
          } catch (error) {
            // The turn can end between reading activeTurn and app-server taking the steer.
            console.warn(`[codex] steer refused: ${error instanceof Error ? error.message : String(error)}`);
            return false;
          }
        },

        subagentsRunning() {
          return [...children.values()].filter((child) => child.running).length;
        },

        async interruptSubagents() {
          await Promise.all([...children].flatMap(([id, child]) =>
            child.turnId ? [client.request("turn/interrupt", { threadId: id, turnId: child.turnId })] : []));
        },

        async close() {
          await client.close();
          children.clear();
          const error = new Error("the reviewer process was stopped");
          for (const listener of listeners) listener({ method: EXIT, params: { error } });
        },
      };
    },
  };
}

export function codexCredentialsFromEnv(env: NodeJS.ProcessEnv, defaultModel: string): CodexCredentials {
  const baseUrl = env.GALI_MODEL_GATEWAY_URL?.trim().replace(/\/$/, "");
  const token = env.GALI_MODEL_GATEWAY_TOKEN?.trim();
  if (baseUrl || token) {
    if (!baseUrl || !token) throw new Error("GALI_MODEL_GATEWAY_URL and GALI_MODEL_GATEWAY_TOKEN must be set together");
    return { kind: "gateway", baseUrl, token, model: env.GALI_GATEWAY_CODEX_MODEL?.trim() || defaultModel };
  }
  if (env.GALI_SANDBOX_ID?.trim()) throw new Error("hosted sandboxes must use the model gateway");
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("no OpenAI credential is configured for Codex");
  return { kind: "apiKey", apiKey, model: defaultModel };
}
