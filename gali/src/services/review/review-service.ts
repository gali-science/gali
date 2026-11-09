import path from "node:path";
import type { ReviewerEvent } from "../../../shared/domain/contracts.js";
import type { AgentProvider, ExecutionPolicy, ProviderSession, SubagentEvent } from "../../agents/core/types.js";
import {
  REVIEWER_AGENTS_MD,
  readHandoffTag,
  renderReviewerRepair,
  renderReviewerTurn,
  renderSubagentFinished,
  type SubagentStopper,
} from "../../agents/reviewer.js";
import { ensureCodexProfileHome } from "../../agents/providers/codex/codex-home.js";
import { PAPER_CORRECTNESS_SKILL } from "../../agents/skills/paper-correctness.js";
import { ensurePdfCache, syncPdfShadows } from "../projects/pdf-cache.js";
import type { ProjectService } from "../projects/project-service.js";
import type { ReviewDocuments } from "./review-document.js";
import type { ReviewProgress } from "./review-progress.js";

const PASSTHROUGH_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR"] as const;

export type ReviewService = ReturnType<typeof createReviewService>;

class ReviewCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

type Paper = {
  opening: Promise<ProviderSession> | null;
  live: ProviderSession | null;
  queue: Promise<void>;
  /** Leo turns queued or running. */
  jobs: number;
  turn: AbortController | null;
  idleTimer: NodeJS.Timeout | null;
  subagentTimer: NodeJS.Timeout | null;
  subagentStoppedBy: SubagentStopper | null;
  subagentStamp: Promise<string | null> | null;
  /** Stamp of the agent's files after the last check; undefined until the first turn, which always checks. */
  checked: string | undefined;
};

/**
 * One Codex thread per project, living in the project folder, served by one
 * reviewer process that stops after a quiet spell and resumes the same thread
 * on the next question. Leo's turns on a project run one at a time; a full
 * review runs in his background subagent, so his turns stay short. Only Leo
 * talks to Gali: when the subagent finishes, Leo gets a turn to report it.
 */
export function createReviewService(opts: {
  provider: AgentProvider;
  projects: ProjectService;
  codexHomeRoot: string;
  pdfCacheRoot: string;
  turnMinutes: number;
  subagentMinutes: number;
  idleMinutes: number;
  documents: {
    stamp(projectKey: string): Promise<string>;
    audit(projectKey: string): Promise<string[]>;
    accept(projectKey: string): Promise<void>;
    dismissals: ReviewDocuments["dismissals"];
  };
  emit: (event: ReviewerEvent) => void;
  progress: ReviewProgress;
  onReviewRepaired: (projectKey: string) => void;
}) {
  const papers = new Map<string, Paper>();
  let home: Promise<string> | null = null;

  function paper(projectKey: string): Paper {
    let state = papers.get(projectKey);
    if (!state) {
      state = {
        opening: null,
        live: null,
        queue: Promise.resolve(),
        jobs: 0,
        turn: null,
        idleTimer: null,
        subagentTimer: null,
        subagentStoppedBy: null,
        subagentStamp: null,
        checked: undefined,
      };
      papers.set(projectKey, state);
    }
    return state;
  }

  function codexHome(): Promise<string> {
    home ??= ensureCodexProfileHome({
      profileRoot: opts.codexHomeRoot,
      agentsMd: REVIEWER_AGENTS_MD,
      skills: [PAPER_CORRECTNESS_SKILL],
    });
    return home;
  }

  async function policy(projectKey: string): Promise<ExecutionPolicy> {
    // matplotlib's default macOS window backend aborts Python inside the Codex sandbox.
    const env: Record<string, string> = { CODEX_HOME: await codexHome(), MPLBACKEND: "Agg" };
    for (const name of PASSTHROUGH_ENV) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
    return { workingDirectory: opts.projects.dir(projectKey), env };
  }

  function clearTimer(timer: NodeJS.Timeout | null): null {
    if (timer) clearTimeout(timer);
    return null;
  }

  function dropSession(state: Paper) {
    state.live = null;
    state.opening = null;
    state.idleTimer = clearTimer(state.idleTimer);
    state.subagentTimer = clearTimer(state.subagentTimer);
  }

  async function openSession(projectKey: string): Promise<ProviderSession> {
    const state = paper(projectKey);
    const project = await opts.projects.getRow(projectKey);
    let session: ProviderSession | null = null;
    session = await opts.provider.open({
      threadId: project.reviewThreadId,
      policy: await policy(projectKey),
      onSubagent: (event) => onSubagent(projectKey, event),
      onSubagentStep: (event) => opts.progress.step(projectKey, event, true),
      onExit: (error) => {
        console.warn(`[review] ${projectKey} reviewer process exited: ${error.message}`);
        if (session !== null && state.live === session) dropSession(state);
      },
    });
    if (session.id !== project.reviewThreadId) await opts.projects.setReviewThread(projectKey, session.id);
    state.live = session;
    return session;
  }

  function session(projectKey: string): Promise<ProviderSession> {
    const state = paper(projectKey);
    state.idleTimer = clearTimer(state.idleTimer);
    if (state.live) return Promise.resolve(state.live);
    state.opening ??= openSession(projectKey).finally(() => {
      state.opening = null;
    });
    return state.opening;
  }

  function subagentsRunning(state: Paper): number {
    return state.live?.subagentsRunning() ?? 0;
  }

  function scheduleIdle(projectKey: string) {
    const state = paper(projectKey);
    state.idleTimer = clearTimer(state.idleTimer);
    if (!state.live || state.jobs > 0 || subagentsRunning(state) > 0) return;
    const live = state.live;
    state.idleTimer = setTimeout(() => {
      if (state.live !== live || state.jobs > 0 || subagentsRunning(state) > 0) return;
      dropSession(state);
      void live.close();
    }, opts.idleMinutes * 60_000);
    state.idleTimer.unref();
  }

  function onSubagent(projectKey: string, event: SubagentEvent) {
    const state = paper(projectKey);
    state.idleTimer = clearTimer(state.idleTimer);
    state.subagentTimer = clearTimer(state.subagentTimer);
    opts.emit({ type: "reviewer.reviewing", projectKey, running: event.type === "subagent.started" || subagentsRunning(state) > 0 });
    if (event.type === "subagent.started") {
      const live = state.live;
      state.subagentStoppedBy = null;
      state.subagentStamp = stampOrNull(projectKey);
      state.subagentTimer = setTimeout(() => {
        console.warn(`[review] ${projectKey} review subagent passed ${opts.subagentMinutes} minutes; interrupting`);
        state.subagentStoppedBy = "time limit";
        void live?.interruptSubagents();
      }, opts.subagentMinutes * 60_000);
      state.subagentTimer.unref();
      return;
    }
    const stoppedBy = state.subagentStoppedBy;
    state.subagentStoppedBy = null;
    const before = state.subagentStamp;
    state.subagentStamp = null;
    const after = before ? stampOrNull(projectKey) : null;
    enqueue(
      projectKey,
      { question: "The background job finished; report it.", summary: "Reporting the finished job" },
      async () => {
        const [was, now] = await Promise.all([before, after]);
        return renderSubagentFinished({ ...event, stoppedBy, reviewUnchanged: was != null && was === now });
      },
      true,
    );
  }

  function stampOrNull(projectKey: string): Promise<string | null> {
    return opts.documents.stamp(projectKey).catch((error: unknown) => {
      console.warn(`[review] ${projectKey} stamp failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
  }

  async function questionInput(projectKey: string, question: string): Promise<string> {
    const project = await opts.projects.getRow(projectKey);
    await syncPdfShadows(opts.pdfCacheRoot, opts.projects.dir(projectKey));
    const paper = project.paperPath === null
      ? null
      : {
        path: project.paperPath,
        cache: await ensurePdfCache(opts.pdfCacheRoot, path.join(opts.projects.dir(projectKey), project.paperPath)),
      };
    return renderReviewerTurn({
      question,
      paper,
      dismissed: (await opts.documents.dismissals(projectKey)).length,
    });
  }

  async function runTurn(projectKey: string, input: string): Promise<{ reply: string; handoff: boolean }> {
    const state = paper(projectKey);
    const live = await session(projectKey);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`review turn exceeded ${opts.turnMinutes} minutes`)),
      opts.turnMinutes * 60_000,
    );
    state.turn = controller;
    try {
      let reply = "";
      let handoff = false;
      for await (const event of live.run(input, { signal: controller.signal })) {
        if (event.type === "turn.completed") {
          reply = event.finalResponse.trim();
        } else if (event.type === "handoff") {
          handoff = true;
        } else if (event.type === "turn.failed") {
          throw controller.signal.aborted ? controller.signal.reason : new Error(event.error);
        } else {
          opts.progress.step(projectKey, event);
        }
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!reply) throw new Error("the check finished without a reply");
      return { reply, handoff };
    } finally {
      clearTimeout(timer);
      state.turn = null;
    }
  }

  /** Checks the agent's files once they settle: the subagent owns them while it runs. */
  async function checkReview(projectKey: string) {
    const state = paper(projectKey);
    if (subagentsRunning(state) > 0) return;
    if ((await opts.documents.stamp(projectKey)) === state.checked) return;
    // The spoken answer is already out; the fix-up runs in the same queue slot,
    // and a failed one leaves the problems listed in the Review panel.
    const problems = await opts.documents.audit(projectKey);
    if (problems.length > 0) {
      await runTurn(projectKey, renderReviewerRepair(problems.join("\n"))).catch((error: unknown) => {
        console.warn(`[review] ${projectKey} repair failed: ${error instanceof Error ? error.message : String(error)}`);
      });
      opts.onReviewRepaired(projectKey);
    }
    await opts.documents.accept(projectKey);
    state.checked = await opts.documents.stamp(projectKey);
  }

  function enqueue(
    projectKey: string,
    label: { question: string; summary: string },
    input: () => Promise<string>,
    reportsJob = false,
  ) {
    const state = paper(projectKey);
    opts.emit({ type: "reviewer.started", projectKey, ...label });
    opts.progress.start(projectKey, label.summary);
    state.jobs += 1;
    state.idleTimer = clearTimer(state.idleTimer);
    state.queue = state.queue
      .then(async () => {
        try {
          const { reply, handoff } = await runTurn(projectKey, await input());
          const { text, tagged } = readHandoffTag(reply);
          const quiet = handoff && tagged && !reportsJob;
          opts.emit({ type: "reviewer.finished", projectKey, status: "succeeded", message: text, ...(quiet ? { quiet: true as const } : {}) });
        } catch (error) {
          opts.emit(error instanceof ReviewCancelled
            ? { type: "reviewer.finished", projectKey, status: "cancelled" }
            : {
              type: "reviewer.finished",
              projectKey,
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            });
        }
        await checkReview(projectKey);
      })
      .catch((error: unknown) => {
        console.error(`[review] ${projectKey} review check failed:`, error);
      })
      .finally(() => {
        state.jobs -= 1;
        if (state.jobs === 0 && subagentsRunning(state) === 0) opts.progress.stop(projectKey);
        scheduleIdle(projectKey);
      });
  }

  return {
    /** Queues the question and returns at once; the answer arrives as a reviewer.finished event. */
    ask(projectKey: string, question: string, summary: string): void {
      enqueue(projectKey, { question, summary }, () => questionInput(projectKey, question));
    },

    /** Stops Leo's current turn and the background review. */
    cancel(projectKey: string): boolean {
      const state = papers.get(projectKey);
      if (!state) return false;
      let cancelled = false;
      if (state.turn) {
        state.turn.abort(new ReviewCancelled());
        cancelled = true;
      }
      if (state.live && subagentsRunning(state) > 0) {
        state.subagentStoppedBy = "human";
        void state.live.interruptSubagents().catch((error: unknown) => {
          console.warn(`[review] ${projectKey} interrupt failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        cancelled = true;
      }
      return cancelled;
    },

    /** Stops the project's reviewer process for good, e.g. before deleting it. */
    async forget(projectKey: string): Promise<void> {
      const state = papers.get(projectKey);
      if (!state) return;
      const live = state.live ?? (await state.opening?.catch(() => null)) ?? null;
      dropSession(state);
      papers.delete(projectKey);
      opts.progress.forget(projectKey);
      await live?.close();
    },

    /** The live log while the agent works on this project, else its last run; null before any run. */
    progress(projectKey: string) {
      return opts.progress.read(projectKey);
    },

    /** Leo turns queued or running on one project; with no key, everything that keeps the sandbox awake. */
    busy(projectKey?: string): number {
      if (projectKey !== undefined) return papers.get(projectKey)?.jobs ?? 0;
      let total = 0;
      for (const state of papers.values()) total += state.jobs + subagentsRunning(state);
      return total;
    },

    /** Whether the background review is running on this project. */
    reviewing(projectKey: string): boolean {
      const state = papers.get(projectKey);
      return state !== undefined && subagentsRunning(state) > 0;
    },
  };
}
