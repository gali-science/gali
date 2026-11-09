import path from "node:path";
import type {
  AgentTraceLine,
  ReviewProgressDto,
  ReviewProgressEntry,
  ReviewProgressEvent,
} from "../../../shared/domain/contracts.js";
import type { ProviderTurnEvent } from "../../agents/core/types.js";

const ACTIONS_MAX_CHARS = 6000;
const COMMAND_CHARS = 400;
const OUTPUT_CHARS = 300;
const NOTE_CHARS = 300;
const SHOWN_COMMAND_CHARS = 200;
const TRACE_LINES = 500;
const TRACE_TEXT_CHARS = 2000;
const TRACE_OUTPUT_CHARS = 4000;

export type ReviewProgress = ReturnType<typeof createReviewProgress>;

type Run = {
  title: string;
  startedAt: number;
  finishedAt: number | null;
  entries: ReviewProgressEntry[];
  trace: AgentTraceLine[];
  actions: string[];
  commands: string[];
  previous: string | null;
  drawing: boolean;
  timer: NodeJS.Timeout;
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// The end of a command's output holds the result or the error.
function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

function bareCommand(command: string): string {
  const shell = /^\/bin\/(?:ba|z)?sh -lc (['"])([\s\S]*)\1$/.exec(command);
  return (shell ? shell[2]! : command).trim();
}

function describeStep(event: ProviderTurnEvent): string | null {
  switch (event.type) {
    case "command":
      return `$ ${clip(bareCommand(event.command), COMMAND_CHARS)}\n${clip(event.output ?? "", OUTPUT_CHARS)}`;
    case "image":
      return `looked at ${path.basename(event.path)}`;
    case "reasoning":
      return `note: ${clip(event.text, NOTE_CHARS)}`;
    case "message":
      return `said: ${clip(event.text, NOTE_CHARS)}`;
    case "files":
      return `edited ${event.paths.map((file) => path.basename(file)).join(", ")}`;
    case "tool":
      return `used ${event.name}`;
    case "handoff":
    case "turn.started":
    case "turn.completed":
    case "turn.failed":
      return null;
  }
}

function traceLine(event: ProviderTurnEvent, background: boolean): AgentTraceLine | null {
  const line = { at: Date.now(), output: null, exitCode: null, background };
  switch (event.type) {
    case "command":
      return {
        ...line,
        kind: "command",
        text: clip(bareCommand(event.command), TRACE_TEXT_CHARS),
        output: event.output ? clipTail(event.output.trimEnd(), TRACE_OUTPUT_CHARS) : null,
        exitCode: event.exitCode ?? null,
      };
    case "image":
      return { ...line, kind: "image", text: event.path };
    case "reasoning":
      return { ...line, kind: "reasoning", text: clip(event.text, TRACE_TEXT_CHARS) };
    case "message":
      return { ...line, kind: "message", text: clip(event.text, TRACE_TEXT_CHARS) };
    case "files":
      return { ...line, kind: "files", text: event.paths.join(", ") };
    case "tool":
      return { ...line, kind: "tool", text: event.name };
    case "handoff":
    case "turn.started":
    case "turn.completed":
    case "turn.failed":
      return null;
  }
}

/** The newest actions that fit the prompt, oldest first. */
function newest(actions: string[]): string[] {
  const kept: string[] = [];
  let size = 0;
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    size += actions[index]!.length;
    if (size > ACTIONS_MAX_CHARS && kept.length > 0) break;
    kept.unshift(actions[index]!);
  }
  return kept;
}

/**
 * The live log of a busy agent: its raw steps form the trace, and on each tick
 * with new steps the fast model turns them into one short line. The last run
 * stays readable after it ends, until the next one starts.
 */
export function createReviewProgress(opts: {
  tickMs: number;
  describe: (input: { previous: string | null; actions: string[] }) => Promise<string>;
  emit: (event: ReviewProgressEvent) => void;
}) {
  const live = new Map<string, Run>();
  const last = new Map<string, Run>();

  async function draw(projectKey: string, run: Run) {
    if (run.drawing || run.actions.length === 0) return;
    const actions = run.actions.splice(0);
    const commands = run.commands.splice(0);
    run.drawing = true;
    try {
      const text = await opts.describe({ previous: run.previous, actions: newest(actions) });
      if (live.get(projectKey) !== run) return;
      run.previous = text;
      const entry = { text, at: Date.now(), commands };
      run.entries.push(entry);
      opts.emit({ projectKey, entry });
    } catch (error) {
      // The log is a courtesy; a failed line must never touch the review.
      console.warn(`[review-progress] ${projectKey}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      run.drawing = false;
    }
  }

  return {
    /** Opens the log unless one is open already. */
    start(projectKey: string, title: string) {
      if (live.has(projectKey)) return;
      last.delete(projectKey);
      const run: Run = {
        title,
        startedAt: Date.now(),
        finishedAt: null,
        entries: [],
        trace: [],
        actions: [],
        commands: [],
        previous: null,
        drawing: false,
        timer: setInterval(() => void draw(projectKey, run), opts.tickMs),
      };
      run.timer.unref();
      live.set(projectKey, run);
    },

    step(projectKey: string, event: ProviderTurnEvent, background = false) {
      const run = live.get(projectKey);
      if (!run) return;
      const action = describeStep(event);
      if (action) run.actions.push(action);
      if (event.type === "command") run.commands.push(clip(bareCommand(event.command).split("\n")[0]!, SHOWN_COMMAND_CHARS));
      const trace = traceLine(event, background);
      if (!trace) return;
      run.trace.push(trace);
      if (run.trace.length > TRACE_LINES) run.trace.splice(0, run.trace.length - TRACE_LINES);
      opts.emit({ projectKey, trace });
    },

    stop(projectKey: string) {
      const run = live.get(projectKey);
      if (!run) return;
      clearInterval(run.timer);
      live.delete(projectKey);
      run.finishedAt = Date.now();
      last.set(projectKey, run);
    },

    forget(projectKey: string) {
      this.stop(projectKey);
      last.delete(projectKey);
    },

    read(projectKey: string): ReviewProgressDto {
      const run = live.get(projectKey) ?? last.get(projectKey);
      return run
        ? { title: run.title, startedAt: run.startedAt, finishedAt: run.finishedAt, entries: run.entries, trace: run.trace }
        : null;
    },
  };
}
