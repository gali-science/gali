import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { AgentTraceLine, ReviewerEvent } from "../shared/domain/contracts.js";
import type { ProjectService } from "../src/services/projects/project-service.js";
import { createReviewProgress } from "../src/services/review/review-progress.js";
import { createReviewService } from "../src/services/review/review-service.js";
import { CTC_DRO_PDF, createFakeProvider, waitFor } from "./support/test-app.js";
import { createTestWorkspace } from "./test.config.js";

const IDLE_MS = 150;
const PROGRESS_TICK_MS = 30;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup(provider = createFakeProvider(), subagentMinutes = 1, stamp: () => Promise<string> = async () => "-") {
  const workspace = createTestWorkspace("review-service");
  cleanups.push(workspace.cleanup);
  const projectDir = path.join(workspace.root, "paper-a");
  fs.mkdirSync(path.join(projectDir, "paper"), { recursive: true });
  fs.copyFileSync(CTC_DRO_PDF, path.join(projectDir, "paper", "ctc-dro.pdf"));
  let reviewThreadId: string | null = null;
  const projects = {
    dir: () => projectDir,
    getRow: async () => ({ paperPath: "paper/ctc-dro.pdf", reviewThreadId }),
    setReviewThread: async (_key: string, id: string) => {
      reviewThreadId = id;
    },
  } as unknown as ProjectService;
  const events: ReviewerEvent[] = [];
  const progressed: Array<{ projectKey: string; text: string; commands: string[] }> = [];
  const traced: AgentTraceLine[] = [];
  const described: string[][] = [];
  const progress = createReviewProgress({
    tickMs: PROGRESS_TICK_MS,
    describe: async ({ actions }) => {
      described.push(actions);
      return `step ${described.length}`;
    },
    emit: (event) => {
      if ("entry" in event) progressed.push({ projectKey: event.projectKey, text: event.entry.text, commands: event.entry.commands });
      else traced.push(event.trace);
    },
  });
  const review = createReviewService({
    provider: provider.provider,
    projects,
    codexHomeRoot: path.join(workspace.dataDir, "codex"),
    pdfCacheRoot: path.join(workspace.dataDir, "pdf-cache"),
    turnMinutes: 1,
    subagentMinutes,
    idleMinutes: IDLE_MS / 60_000,
    documents: {
      stamp,
      audit: async () => [],
      accept: async () => {},
      dismissals: async () => [],
    },
    emit: (event) => events.push(event),
    progress,
    onReviewRepaired: () => {},
  });
  const finished = () => events.filter((event) => event.type === "reviewer.finished");
  return { review, events, finished, progressed, traced, described, ...provider };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the reviewer process stops after the idle spell and the next question resumes the same thread", async () => {
  const { review, finished, opens, sessions } = setup();

  review.ask("a", "one", "one");
  await waitFor(() => finished().length === 1 || undefined);
  expect(sessions[0]!.closed).toBe(false);
  await waitFor(() => sessions[0]!.closed || undefined);

  review.ask("a", "two", "two");
  await waitFor(() => finished().length === 2 || undefined);
  expect(opens).toEqual([{ threadId: null }, { threadId: "thread-1" }]);
});

test("a running background review keeps the process and the sandbox awake", async () => {
  const provider = createFakeProvider((input, session) => {
    if (input.includes("review it")) session.startSubagent();
    return "ok";
  });
  const { review, finished, sessions, turns } = setup(provider);

  review.ask("a", "review it", "review");
  await waitFor(() => finished().length === 1 || undefined);
  await sleep(IDLE_MS * 3);
  expect(sessions[0]!.closed).toBe(false);
  expect(review.busy("a")).toBe(0);
  expect(review.busy()).toBe(1);

  sessions[0]!.finishSubagent();
  await waitFor(() => finished().length === 2 || undefined);
  expect(turns[1]!.input).toContain("The background job finished");
  await waitFor(() => sessions[0]!.closed || undefined);
  expect(review.busy()).toBe(0);
});

test("a background job that ends without changing review.json is reported as unsaved, not restarted", async () => {
  let reviewStamp = "100";
  const provider = createFakeProvider((input, session) => {
    if (input.includes("review it")) session.startSubagent();
    return "ok";
  });
  const { review, finished, sessions, turns } = setup(provider, 1, async () => reviewStamp);

  review.ask("a", "review it", "review");
  await waitFor(() => finished().length === 1 || undefined);
  sessions[0]!.finishSubagent();
  await waitFor(() => finished().length === 2 || undefined);
  expect(turns[1]!.input).toContain(
    "It did not change review.json. If the job was meant to write findings, tell the human in one sentence that its findings were not saved and ask whether to run it again. Do not start it again on your own.",
  );

  review.ask("a", "review it", "review");
  await waitFor(() => finished().length === 3 || undefined);
  reviewStamp = "200";
  sessions[0]!.finishSubagent();
  await waitFor(() => finished().length === 4 || undefined);
  expect(turns[3]!.input).toContain("The background job finished");
  expect(turns[3]!.input).not.toContain("It did not change review.json");
});

test("the live log turns the background review's steps into lines and a raw trace, and stays readable after all work ends", async () => {
  const provider = createFakeProvider((input, session) => {
    if (input.includes("review it")) session.startSubagent();
    return "ok";
  });
  const { review, finished, sessions, progressed, traced, described } = setup(provider);

  expect(review.progress("a")).toBeNull();
  review.ask("a", "review it", "Full review");
  await waitFor(() => finished().length === 1 || undefined);
  await waitFor(() => progressed.length === 1 || undefined);
  expect(review.progress("a")).toMatchObject({ title: "Full review", entries: [{ text: "step 1" }] });

  sessions[0]!.subagentStep({ type: "command", command: "/bin/zsh -lc 'nl -ba code/dro.py'", status: "completed", output: "1 import torch", exitCode: 0 });
  sessions[0]!.subagentStep({ type: "image", path: "/cache/page-5.png" });
  await waitFor(() => progressed.length === 2 || undefined);
  expect(described[1]).toEqual(["$ nl -ba code/dro.py\n1 import torch", "looked at page-5.png"]);
  expect(progressed[1]).toEqual({ projectKey: "a", text: "step 2", commands: ["nl -ba code/dro.py"] });
  expect(traced.filter((line) => line.background)).toMatchObject([
    { kind: "command", text: "nl -ba code/dro.py", output: "1 import torch", exitCode: 0 },
    { kind: "image", text: "/cache/page-5.png", output: null },
  ]);

  await sleep(PROGRESS_TICK_MS * 4);
  expect(described).toHaveLength(2);

  sessions[0]!.finishSubagent();
  await waitFor(() => (finished().length === 2 && review.busy("a") === 0) || undefined);
  const last = review.progress("a");
  expect(last?.finishedAt).toEqual(expect.any(Number));
  expect(last?.trace.length).toBe(traced.length);

  review.ask("a", "again", "Second run");
  expect(review.progress("a")).toMatchObject({ title: "Second run", finishedAt: null, entries: [], trace: [] });
});

test("a background review past its time limit is stopped, and Leo is told it was the time limit", async () => {
  const provider = createFakeProvider((input, session) => {
    if (input.includes("review it")) session.startSubagent();
    return "ok";
  });
  const { review, finished, sessions, turns } = setup(provider, 100 / 60_000);

  review.ask("a", "review it", "review");
  await waitFor(() => finished().length === 2 || undefined);
  expect(sessions[0]!.interrupts).toBe(1);
  expect(turns[1]!.input).toContain("The background job reached its time limit and was stopped before it finished.");
});

test("cancel stops the background review, and Leo reports that it did not finish", async () => {
  const provider = createFakeProvider((input, session) => {
    if (input.includes("review it")) session.startSubagent();
    return "ok";
  });
  const { review, finished, sessions, turns } = setup(provider);

  expect(review.cancel("a")).toBe(false);
  review.ask("a", "review it", "review");
  await waitFor(() => review.reviewing("a") || undefined);
  await waitFor(() => finished().length === 1 || undefined);
  expect(review.cancel("a")).toBe(true);
  await waitFor(() => finished().length === 2 || undefined);
  expect(sessions[0]!.interrupts).toBe(1);
  expect(turns[1]!.input).toContain("The background job was stopped by the human before it finished.");
  expect(review.reviewing("a")).toBe(false);
});

test("a stopped turn reports cancelled and a broken one failed", async () => {
  let release = () => {};
  const provider = createFakeProvider((input) => {
    if (input.includes("broken")) throw new Error("model down");
    return new Promise<string>((resolve) => {
      release = () => resolve("ok");
    });
  });
  const { review, finished, turns } = setup(provider);

  review.ask("a", "start e1", "Start e1");
  await waitFor(() => turns.length === 1 || undefined);
  expect(review.cancel("a")).toBe(true);
  release();
  await waitFor(() => finished().length === 1 || undefined);
  expect(finished()[0]).toEqual({ type: "reviewer.finished", projectKey: "a", status: "cancelled" });

  review.ask("a", "broken", "Broken");
  await waitFor(() => finished().length === 2 || undefined);
  expect(finished()[1]).toEqual({ type: "reviewer.finished", projectKey: "a", status: "failed", error: "model down" });
});

test("only a tagged reply from a turn that handed work to a job is quiet; answers and job reports are always spoken", async () => {
  const provider = createFakeProvider((input, session) => {
    if (input.includes("make a plot")) {
      session.startSubagent();
      return "[handoff] The plot job has started.";
    }
    if (input.includes("what about deltas")) {
      session.startSubagent();
      return "Deltas are worth one focused test; the job has started.";
    }
    if (input.includes("is eq 3 right")) return "[Handoff] Eq. 3 holds on page 4.";
    if (input.includes("The background job finished")) {
      session.startSubagent();
      return "[handoff] The first run was cut short, so I've restarted it.";
    }
    return "All four methods gave silhouette 0.359 [handoff].";
  });
  const { review, finished, sessions } = setup(provider);

  review.ask("a", "make a plot", "Plot");
  review.ask("a", "what about deltas", "Deltas");
  review.ask("a", "is eq 3 right", "Eq. 3");
  review.ask("a", "summarize the runs", "Runs");
  await waitFor(() => finished().length === 4 || undefined);
  sessions[0]!.finishSubagent();
  await waitFor(() => finished().length === 5 || undefined);

  expect(finished()).toEqual([
    { type: "reviewer.finished", projectKey: "a", status: "succeeded", message: "The plot job has started.", quiet: true },
    { type: "reviewer.finished", projectKey: "a", status: "succeeded", message: "Deltas are worth one focused test; the job has started." },
    { type: "reviewer.finished", projectKey: "a", status: "succeeded", message: "Eq. 3 holds on page 4." },
    { type: "reviewer.finished", projectKey: "a", status: "succeeded", message: "All four methods gave silhouette 0.359." },
    { type: "reviewer.finished", projectKey: "a", status: "succeeded", message: "The first run was cut short, so I've restarted it." },
  ]);
});

test("a crashed reviewer process reopens on the same thread to report the lost review", async () => {
  const provider = createFakeProvider((input, session) => {
    if (input.includes("review it")) session.startSubagent();
    return "ok";
  });
  const { review, finished, sessions, opens, turns } = setup(provider);

  review.ask("a", "review it", "review");
  await waitFor(() => finished().length === 1 || undefined);
  sessions[0]!.crash();
  await waitFor(() => finished().length === 2 || undefined);

  expect(opens).toEqual([{ threadId: null }, { threadId: "thread-1" }]);
  expect(turns[1]).toMatchObject({ threadId: "thread-1" });
  expect(turns[1]!.input).toContain("The background job failed. Its last message:\ncodex app-server exited (SIGKILL)");
});
