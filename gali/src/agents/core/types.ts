export type ExecutionPolicy = {
  workingDirectory: string;
  env: Record<string, string>;
};

export type ProviderTurnEvent =
  | { type: "turn.started" }
  | { type: "message"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "command"; command: string; status: string; output?: string; exitCode?: number }
  | { type: "files"; paths: string[]; status: string }
  | { type: "tool"; name: string; status: string }
  | { type: "image"; path: string }
  | { type: "handoff" }
  | { type: "turn.completed"; finalResponse: string }
  | { type: "turn.failed"; error: string };

export type SubagentEvent =
  | { type: "subagent.started"; threadId: string }
  | { type: "subagent.finished"; threadId: string; status: "completed" | "interrupted" | "failed"; message: string };

/** One live agent thread. Its subagents keep running between turns until close(). */
export type ProviderSession = {
  readonly id: string;
  run(input: string, opts: { signal: AbortSignal }): AsyncIterable<ProviderTurnEvent>;
  /** Adds a message to the turn in flight; false when no turn takes it (none running, or it just ended). */
  steer(input: string): Promise<boolean>;
  subagentsRunning(): number;
  interruptSubagents(): Promise<void>;
  close(): Promise<void>;
};

export type AgentProvider = {
  open(opts: {
    threadId: string | null;
    policy: ExecutionPolicy;
    onSubagent: (event: SubagentEvent) => void;
    /** Each finished step of a running subagent: commands, page views, notes. */
    onSubagentStep: (event: ProviderTurnEvent) => void;
    /** The session died on its own; it is unusable from here on. */
    onExit: (error: Error) => void;
  }): Promise<ProviderSession>;
};
