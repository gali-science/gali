// The contract between Gali's control plane and whoever hosts user sandboxes.
//
// A user owns one *home*: the durable disk behind their sandbox. Waking the
// home yields a *live sandbox*; sleeping it releases compute and keeps the disk.
// Everything provider-specific (Vercel's snapshot on stop, its egress
// firewall) stays behind this interface.

import type { SandboxFailure, SandboxProviderKind } from "../../../../shared/sandbox-health.js";

export {
  SANDBOX_PROVIDERS,
  type SandboxFailure,
  type SandboxProviderKind,
} from "../../../../shared/sandbox-health.js";

export type RunOptions = {
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
};

export type SpawnOptions = Pick<RunOptions, "env" | "cwd">;

/**
 * A running sandbox. Scripts run as root under `bash -lc`, so
 * `/etc/profile.d` is sourced and wins over `env` for the same name.
 */
export interface LiveSandbox {
  readonly id: string;
  /** Public HTTPS origin for a port. */
  url(port: number): string;
  /** Runs to completion and returns combined output. Throws `SandboxCommandError` on a non-zero exit. */
  run(script: string, options?: RunOptions): Promise<string>;
  /** Starts a process that outlives this call and the calling function. */
  spawn(script: string, options?: SpawnOptions): Promise<void>;
  /** Throws `SandboxFileNotFoundError` when the path does not exist. */
  readFile(path: string): Promise<string>;
  writeFile(path: string, contents: string | Uint8Array): Promise<void>;
  /**
   * Lets the whole sandbox, Codex included, reach `hosts` on top of its
   * standing egress allow-list while `work` runs.
   */
  withEgress<T>(hosts: readonly string[], work: () => Promise<T>): Promise<T>;
}

/**
 * `cold`: nothing from before the wake is running; on-disk process state such
 * as lock files is stale. `warm`: processes from before the wake survived.
 */
export type SandboxBoot = "cold" | "warm";

export type WokenSandbox = {
  /** Durable handle on the user's disk. Opaque outside the provider that issued it. */
  home: string;
  sandbox: LiveSandbox;
  boot: SandboxBoot;
};

export interface SandboxProvider {
  readonly kind: SandboxProviderKind;
  /** Longest a sandbox stays awake before the provider stops it on its own. */
  readonly maxAwakeMs: number;
  /** Whether processes, such as an idle Leo, are still alive after sleep and wake. */
  readonly keepsMemoryOnSleep: boolean;
  /**
   * Brings the user's home up, creating it from the starter image when `home`
   * is null. `owner` is a stable, non-secret label for the user, used to name
   * and tag what the provider creates. Callers must serialize wakes per user.
   */
  wake(home: string | null, owner: string): Promise<WokenSandbox>;
  /** The sandbox if it is running right now, otherwise null. Never wakes anything. */
  attach(sandboxId: string): Promise<LiveSandbox | null>;
  /** Releases compute and keeps the disk. Safe to call when already asleep. */
  sleep(home: string, sandboxId: string | null): Promise<void>;
  /** Deletes the home and everything on its disk. Irreversible. */
  destroy(home: string, sandboxId: string | null): Promise<void>;
}

export class SandboxCommandError extends Error {
  constructor(
    readonly script: string,
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    super(`sandbox command failed (exit ${exitCode ?? "unknown"}): ${script}\n${output.slice(-800)}`);
    this.name = "SandboxCommandError";
  }
}

export class SandboxFileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`sandbox file not found: ${path}`);
    this.name = "SandboxFileNotFoundError";
  }
}

/** The home cannot be brought up, and retrying right away will not change that. */
export class SandboxUnavailableError extends Error {
  constructor(readonly failure: SandboxFailure) {
    super(`${failure.provider} sandbox unavailable (${failure.kind}): ${failure.detail}`);
    this.name = "SandboxUnavailableError";
  }
}

/** The sandbox is coming up on its own, such as during provider recovery; retry shortly. */
export class SandboxBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxBusyError";
  }
}
