import { afterEach, expect, test, vi } from "vitest";
import type { ProviderTurnEvent, SubagentEvent } from "../../../../src/agents/core/types.js";

type Notify = (notification: { method: string; params: Record<string, unknown> }) => void;

const server = vi.hoisted(() => ({
  starts: [] as Array<{ args: string[]; env: Record<string, string> }>,
  requests: [] as Array<{ method: string; params: Record<string, unknown> }>,
  notify: null as Notify | null,
  exit: null as ((error: Error) => void) | null,
  closed: 0,
}));

vi.mock("../../../../src/agents/providers/codex/app-server-client.js", () => ({
  startAppServer: async (opts: { args: string[]; env: Record<string, string>; onNotification: Notify; onExit: (error: Error) => void }) => {
    server.starts.push({ args: opts.args, env: opts.env });
    server.notify = opts.onNotification;
    server.exit = opts.onExit;
    return {
      async request(method: string, params: Record<string, unknown>) {
        server.requests.push({ method, params });
        if (method === "thread/start") return { thread: { id: "leo-1", parentThreadId: null } };
        if (method === "thread/resume") return { thread: { id: params.threadId, parentThreadId: null } };
        if (method === "turn/start") return { turn: { id: `turn-${server.requests.length}`, status: "inProgress", error: null } };
        return {};
      },
      async close() {
        server.closed += 1;
      },
    };
  },
}));

import {
  codexCredentialsFromEnv,
  createCodexProvider,
  type CodexCredentials,
} from "../../../../src/agents/providers/codex/codex-provider.js";

afterEach(() => {
  server.starts.length = 0;
  server.requests.length = 0;
  server.closed = 0;
});

const policy = { workingDirectory: "/papers/adam", env: { PATH: "/bin", CODEX_HOME: "/codex" } };
const notify: Notify = (notification) => server.notify!(notification);
const spawned = (agentThreadId: string) =>
  ({ id: `spawn-${agentThreadId}`, type: "subAgentActivity", kind: "started", agentThreadId, agentPath: `/root/${agentThreadId}` });

function config(args: string[]): Record<string, string> {
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < args.length; i += 2) {
    expect(args[i]).toBe("-c");
    const [key, ...value] = args[i + 1]!.split("=");
    pairs.push([key!, value.join("=")]);
  }
  return Object.fromEntries(pairs);
}

async function open(
  threadId: string | null = null,
  credentials: CodexCredentials = { kind: "apiKey", apiKey: "sk-test", model: "gpt-test" },
) {
  const subagents: SubagentEvent[] = [];
  const steps: ProviderTurnEvent[] = [];
  const exits: Error[] = [];
  const session = await createCodexProvider(credentials).open({
    threadId,
    policy,
    onSubagent: (event) => subagents.push(event),
    onSubagentStep: (event) => steps.push(event),
    onExit: (error) => exits.push(error),
  });
  return { session, subagents, steps, exits };
}

async function collect(run: AsyncIterable<ProviderTurnEvent>, during: () => void): Promise<ProviderTurnEvent[]> {
  const events: ProviderTurnEvent[] = [];
  const iterator = run[Symbol.asyncIterator]();
  const first = await iterator.next();
  events.push(first.value as ProviderTurnEvent);
  during();
  for (;;) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
  }
}

test("starts app-server with v2 subagents capped at one, no goals, workspace writes, network, and the key in env", async () => {
  const { session } = await open();

  expect(session.id).toBe("leo-1");
  expect(server.starts[0]!.env).toEqual({ ...policy.env, CODEX_API_KEY: "sk-test" });
  expect(config(server.starts[0]!.args)).toEqual({
    "features.multi_agent_v2.enabled": "true",
    "features.multi_agent_v2.max_concurrent_threads_per_session": "2",
    "features.goals": "false",
    "sandbox_workspace_write.network_access": "true",
    web_search: '"live"',
    model_provider: '"gali_model"',
    "model_providers.gali_model.name": '"OpenAI"',
    "model_providers.gali_model.base_url": '"https://api.openai.com/v1"',
    "model_providers.gali_model.wire_api": '"responses"',
    "model_providers.gali_model.env_key": '"CODEX_API_KEY"',
  });
  expect(server.requests[0]).toEqual({
    method: "thread/start",
    params: { cwd: "/papers/adam", sandbox: "workspace-write", approvalPolicy: "never", model: "gpt-test" },
  });
});

test("the gateway is an HTTP-only Responses provider, and a saved thread is resumed", async () => {
  const { session } = await open("leo-7", {
    kind: "gateway",
    baseUrl: "https://gali.example/api/model/v1",
    token: "sandbox-token",
    model: "gateway-model",
  });

  expect(session.id).toBe("leo-7");
  expect(server.starts[0]!.env.CODEX_API_KEY).toBe("sandbox-token");
  expect(config(server.starts[0]!.args)).toMatchObject({
    "model_providers.gali_model.base_url": '"https://gali.example/api/model/v1"',
    "model_providers.gali_model.supports_websockets": "false",
  });
  expect(server.requests[0]).toMatchObject({ method: "thread/resume", params: { threadId: "leo-7", model: "gateway-model", excludeTurns: true } });
});

test("a turn yields its own items and ends with the last message; other threads and turns are ignored", async () => {
  const { session } = await open();
  const events = await collect(session.run("Is Eq. 3 right?", { signal: new AbortController().signal }), () => {
    const turnId = "turn-2";
    notify({ method: "item/completed", params: { threadId: "leo-1", turnId, item: { id: "c", type: "commandExecution", command: "ls", status: "completed", aggregatedOutput: "x", exitCode: 0 } } });
    notify({ method: "item/completed", params: { threadId: "child", turnId: "t9", item: { id: "m0", type: "agentMessage", text: "not mine" } } });
    notify({ method: "item/completed", params: { threadId: "leo-1", turnId, item: { id: "m1", type: "agentMessage", text: "Yes, it holds." } } });
    notify({ method: "turn/completed", params: { threadId: "leo-1", turn: { id: turnId, status: "completed", error: null } } });
  });

  expect(server.requests[1]).toEqual({
    method: "turn/start",
    params: { threadId: "leo-1", input: [{ type: "text", text: "Is Eq. 3 right?", text_elements: [] }] },
  });
  expect(events).toEqual([
    { type: "turn.started" },
    { type: "command", command: "ls", status: "completed", output: "x", exitCode: 0 },
    { type: "message", text: "Yes, it holds." },
    { type: "turn.completed", finalResponse: "Yes, it holds." },
  ]);
});

test("a turn that starts or adds to a background job says so with a handoff", async () => {
  const { session } = await open();
  const events = await collect(session.run("Review it", { signal: new AbortController().signal }), () => {
    const turnId = "turn-2";
    notify({ method: "item/completed", params: { threadId: "leo-1", turnId, item: spawned("review") } });
    notify({ method: "item/completed", params: { threadId: "leo-1", turnId, item: { ...spawned("review"), id: "follow", kind: "interacted" } } });
    notify({ method: "item/completed", params: { threadId: "leo-1", turnId, item: { ...spawned("review"), id: "done", kind: "completed" } } });
    notify({ method: "item/completed", params: { threadId: "leo-1", turnId, item: { id: "m1", type: "agentMessage", text: "Started." } } });
    notify({ method: "turn/completed", params: { threadId: "leo-1", turn: { id: turnId, status: "completed", error: null } } });
  });

  expect(events).toEqual([
    { type: "turn.started" },
    { type: "handoff" },
    { type: "handoff" },
    { type: "message", text: "Started." },
    { type: "turn.completed", finalResponse: "Started." },
  ]);
});

test("aborting a turn interrupts it, and a failed turn reports its error", async () => {
  const { session } = await open();
  const controller = new AbortController();
  const events = await collect(session.run("long", { signal: controller.signal }), () => {
    controller.abort();
    notify({ method: "turn/completed", params: { threadId: "leo-1", turn: { id: "turn-2", status: "interrupted", error: null } } });
  });

  expect(server.requests.at(-1)).toEqual({ method: "turn/interrupt", params: { threadId: "leo-1", turnId: "turn-2" } });
  expect(events.at(-1)).toEqual({ type: "turn.failed", error: "the turn was interrupted" });

  const failed = await collect(session.run("again", { signal: new AbortController().signal }), () => {
    notify({ method: "turn/completed", params: { threadId: "leo-1", turn: { id: "turn-4", status: "failed", error: { message: "401 Unauthorized" } } } });
  });
  expect(failed.at(-1)).toEqual({ type: "turn.failed", error: "401 Unauthorized" });
});

test("tracks Leo's subagent across his turns, forwards its steps, and reports its last message when it finishes", async () => {
  const { session, subagents, steps } = await open();

  notify({ method: "turn/started", params: { threadId: "stranger", turn: { id: "st-1", status: "inProgress", error: null } } });
  notify({ method: "turn/started", params: { threadId: "review", turn: { id: "rt-1", status: "inProgress", error: null } } });
  notify({ method: "item/started", params: { threadId: "leo-1", turnId: "turn-x", item: spawned("review") } });
  notify({ method: "item/completed", params: { threadId: "leo-1", turnId: "turn-x", item: spawned("review") } });
  expect(session.subagentsRunning()).toBe(1);

  await session.interruptSubagents();
  expect(server.requests.at(-1)).toEqual({ method: "turn/interrupt", params: { threadId: "review", turnId: "rt-1" } });

  notify({ method: "item/completed", params: { threadId: "stranger", turnId: "st-1", item: { id: "s", type: "agentMessage", text: "not Leo's" } } });
  notify({ method: "item/completed", params: { threadId: "review", turnId: "rt-1", item: { id: "v", type: "imageView", path: "/cache/page-5.png" } } });
  notify({ method: "item/completed", params: { threadId: "review", turnId: "rt-1", item: { id: "m", type: "agentMessage", text: "Two serious issues." } } });
  notify({ method: "turn/completed", params: { threadId: "review", turn: { id: "rt-1", status: "completed", error: null } } });

  expect(steps).toEqual([{ type: "image", path: "/cache/page-5.png" }, { type: "message", text: "Two serious issues." }]);
  expect(session.subagentsRunning()).toBe(0);
  expect(subagents).toEqual([
    { type: "subagent.started", threadId: "review" },
    { type: "subagent.finished", threadId: "review", status: "completed", message: "Two serious issues." },
  ]);
});

test("when the process dies, a running subagent is reported failed and the running turn throws", async () => {
  const { session, subagents, exits } = await open();
  notify({ method: "item/completed", params: { threadId: "leo-1", turnId: "turn-x", item: spawned("review") } });

  await expect(collect(session.run("q", { signal: new AbortController().signal }), () => {
    server.exit!(new Error("codex app-server exited (SIGKILL)"));
  })).rejects.toThrow("codex app-server exited (SIGKILL)");

  expect(subagents.at(-1)).toEqual({ type: "subagent.finished", threadId: "review", status: "failed", message: "codex app-server exited (SIGKILL)" });
  expect(exits).toHaveLength(1);
  expect(session.subagentsRunning()).toBe(0);
  await session.close();
  expect(server.closed).toBe(1);
});

test("closing the session mid-turn ends the turn instead of leaving it waiting", async () => {
  const { session, exits } = await open();
  await expect(collect(session.run("q", { signal: new AbortController().signal }), () => {
    void session.close();
  })).rejects.toThrow("the reviewer process was stopped");
  expect(exits).toEqual([]);
});

test("credentials come from the gateway env, or a local key outside a sandbox", () => {
  expect(codexCredentialsFromEnv({
    GALI_MODEL_GATEWAY_URL: "https://gali.example/api/model/v1/",
    GALI_MODEL_GATEWAY_TOKEN: "t",
    GALI_GATEWAY_CODEX_MODEL: "kimi",
  }, "default")).toEqual({ kind: "gateway", baseUrl: "https://gali.example/api/model/v1", token: "t", model: "kimi" });
  expect(codexCredentialsFromEnv({ OPENAI_API_KEY: "sk" }, "default"))
    .toEqual({ kind: "apiKey", apiKey: "sk", model: "default" });
  expect(() => codexCredentialsFromEnv({ GALI_MODEL_GATEWAY_URL: "https://x" }, "default")).toThrow(/together/);
  expect(() => codexCredentialsFromEnv({ GALI_SANDBOX_ID: "sbx", OPENAI_API_KEY: "sk" }, "default"))
    .toThrow(/model gateway/);
});
