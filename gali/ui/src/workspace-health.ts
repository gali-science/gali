import {
  describeSandboxFailure,
  type SandboxFailure,
} from "../../shared/sandbox-health";

export type WorkspaceHealth =
  | { state: "ok" }
  | { state: "reconnecting"; since: number }
  | { state: "unavailable"; failure: SandboxFailure };

// Stream rollovers and deploys drop the connection for a second or two; only
// an outage that outlasts this is worth showing.
export const RECONNECTING_GRACE_MS = 5_000;

export type WorkspaceHealthView = {
  current(): WorkspaceHealth;
  subscribe(listener: () => void): () => void;
};

export type WorkspaceHealthMonitor = WorkspaceHealthView & {
  /** Something got an answer from the workspace. */
  reached(): void;
  /** A request or the stream failed in a way that may pass on its own. */
  lost(): void;
  /** The control plane says the workspace cannot run, and why. */
  unavailable(failure: SandboxFailure): void;
};

export class WorkspaceUnavailableError extends Error {
  constructor(readonly failure: SandboxFailure) {
    super(describeSandboxFailure(failure));
    this.name = "WorkspaceUnavailableError";
  }
}

const OK: WorkspaceHealth = { state: "ok" };

export function createWorkspaceHealthMonitor(): WorkspaceHealthMonitor {
  let health = OK;
  let lostSince: number | null = null;
  let grace: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  function set(next: WorkspaceHealth) {
    if (next === health) return;
    health = next;
    for (const listener of listeners) listener();
  }

  function clearGrace() {
    if (grace) clearTimeout(grace);
    grace = null;
  }

  return {
    current: () => health,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reached() {
      clearGrace();
      lostSince = null;
      set(OK);
    },
    // An unavailable workspace stays red through the retries that follow; only
    // getting an answer turns it back.
    lost() {
      if (health.state !== "ok" || lostSince !== null) return;
      const since = Date.now();
      lostSince = since;
      grace = setTimeout(() => {
        grace = null;
        set({ state: "reconnecting", since });
      }, RECONNECTING_GRACE_MS);
    },
    unavailable(failure) {
      clearGrace();
      lostSince = null;
      if (
        health.state === "unavailable"
        && health.failure.kind === failure.kind
        && health.failure.detail === failure.detail
      ) {
        return;
      }
      set({ state: "unavailable", failure });
    },
  };
}
