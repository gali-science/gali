import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import type { NavEvent, ProjectDto, ProjectEvent, ReviewProgressEvent, ReviewerEvent } from "../../shared/domain/contracts.js";
import type { AgentProvider, ExecutionPolicy, ProviderTurnEvent } from "../../src/agents/core/types.js";
import { createAppContext } from "../../src/application/app-context.js";
import { createToolRegistry } from "../../src/voice/tools/registry.js";
import type { TestWorkspace } from "../test.config.js";

export const CTC_DRO_PDF = path.join(import.meta.dirname, "../fixtures/ctc-dro.pdf");

export type FakeTurn = { threadId: string; input: string; policy: ExecutionPolicy };

export type FakeSession = {
  id: string;
  closed: boolean;
  interrupts: number;
  startSubagent(): void;
  finishSubagent(status?: "completed" | "interrupted" | "failed", message?: string): void;
  subagentStep(event: ProviderTurnEvent): void;
  /** The process dies on its own, taking a running subagent with it. */
  crash(): void;
};

/** Replies "answer N" to the Nth turn and records what it was asked. */
export function createFakeProvider(reply?: (input: string, session: FakeSession) => Promise<string> | string) {
  const turns: FakeTurn[] = [];
  const opens: Array<{ threadId: string | null }> = [];
  const sessions: FakeSession[] = [];
  let threads = 0;
  const provider: AgentProvider = {
    async open({ threadId, policy, onSubagent, onSubagentStep, onExit }) {
      opens.push({ threadId });
      const id = threadId ?? `thread-${++threads}`;
      let running = 0;
      const fake: FakeSession = {
        id,
        closed: false,
        interrupts: 0,
        startSubagent() {
          running += 1;
          onSubagent({ type: "subagent.started", threadId: `${id}/review` });
        },
        finishSubagent(status = "completed", message = "review done") {
          running -= 1;
          onSubagent({ type: "subagent.finished", threadId: `${id}/review`, status, message });
        },
        subagentStep: onSubagentStep,
        crash() {
          fake.closed = true;
          if (running > 0) fake.finishSubagent("failed", "codex app-server exited (SIGKILL)");
          onExit(new Error("codex app-server exited (SIGKILL)"));
        },
      };
      sessions.push(fake);
      return {
        id,
        async *run(input: string): AsyncIterable<ProviderTurnEvent> {
          turns.push({ threadId: id, input, policy });
          yield { type: "turn.started" };
          const before = running;
          const text = reply ? await reply(input, fake) : `answer ${turns.length}`;
          if (running > before) yield { type: "handoff" };
          yield { type: "message", text };
          yield { type: "turn.completed", finalResponse: text };
        },
        steer: async () => false,
        subagentsRunning: () => running,
        async interruptSubagents() {
          fake.interrupts += 1;
          if (running > 0) fake.finishSubagent("interrupted", "stopped");
        },
        async close() {
          fake.closed = true;
        },
      };
    },
  };
  return { provider, turns, opens, sessions };
}

export async function createTestApp(
  workspace: TestWorkspace,
  provider?: AgentProvider,
) {
  const reviewerEvents: ReviewerEvent[] = [];
  const projectEvents: ProjectEvent[] = [];
  const navEvents: NavEvent[] = [];
  const progressEvents: ReviewProgressEvent[] = [];
  const titlePages: string[] = [];
  const app = await createAppContext({
    dataDir: workspace.dataDir,
    migrations: path.resolve("drizzle"),
    provider: provider ?? createFakeProvider().provider,
    extractPaperTitle: async (firstPage) => {
      titlePages.push(firstPage);
      return "CTC-DRO: Robust Optimization for Reducing Language Disparities in Speech Recognition";
    },
    onReviewerEvent: (event) => reviewerEvents.push(event),
    onProjectEvent: (event) => projectEvents.push(event),
    onReviewProgress: (event) => progressEvents.push(event),
    reviewProgressLine: async ({ actions }) => `did ${actions.length} things`,
  });
  const registry = createToolRegistry({ app, onNav: (event) => navEvents.push(event) });
  return {
    app,
    registry,
    navEvents,
    reviewerEvents,
    projectEvents,
    progressEvents,
    titlePages,
    close: () => app.client.close(),
  };
}

export function codeZip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

/** Lays out an extracted upload the way the browser packs it, then creates the project. */
export async function uploadProject(
  app: Awaited<ReturnType<typeof createAppContext>>,
  workspace: TestWorkspace,
  input: { title: string; pdf?: string; pdfName?: string; code?: Record<string, string> },
): Promise<ProjectDto> {
  const uploadDir = fs.mkdtempSync(path.join(workspace.root, "upload-"));
  fs.mkdirSync(path.join(uploadDir, "paper"));
  fs.copyFileSync(input.pdf ?? CTC_DRO_PDF, path.join(uploadDir, "paper", input.pdfName ?? "ctc-dro.pdf"));
  fs.writeFileSync(
    path.join(uploadDir, "code.zip"),
    codeZip(input.code ?? { "repo/train.py": "print('train')\n", "repo/README.md": "# CTC-DRO\n" }),
  );
  return app.projects.createFromUpload({ title: input.title, uploadDir });
}

export async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
