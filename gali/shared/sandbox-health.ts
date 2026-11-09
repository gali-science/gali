// Why a user's sandbox cannot run, in one shape for the control plane that
// detects it and the browser that shows it.

export const SANDBOX_PROVIDERS = ["vercel"] as const;
export type SandboxProviderKind = (typeof SANDBOX_PROVIDERS)[number];

export type SandboxFailureKind =
  | "start_failed"
  | "out_of_capacity"
  | "out_of_memory"
  | "crashed"
  | "home_missing"
  | "server_failed";

export type SandboxFailure = {
  kind: SandboxFailureKind;
  provider: SandboxProviderKind;
  // The provider's own status and reason, verbatim. The kind is our best
  // reading of it; this is the record.
  detail: string;
};

export type SandboxErrorBody =
  | { error: "sandbox_unavailable"; failure: SandboxFailure; requestId: string }
  | { error: "sandbox_waking"; requestId: string };

/** What a wake is doing right now, streamed to the boot screen. */
export type WakeProgressPhase = "waking" | "waiting" | "updating" | "starting";

// Ensure streams these as newline-delimited JSON when asked; the HTTP status is
// committed at the first line, so a failure travels inside the last one.
export const ENSURE_STREAM_TYPE = "application/x-ndjson";
export type EnsureStreamLine =
  | { type: "progress"; phase: WakeProgressPhase }
  | { type: "ready"; sandboxId: string }
  | { type: "failed"; status: number; body: unknown };

const FAILURE_KINDS: ReadonlySet<string> = new Set<SandboxFailureKind>([
  "start_failed",
  "out_of_capacity",
  "out_of_memory",
  "crashed",
  "home_missing",
  "server_failed",
]);

function isFailure(value: unknown): value is SandboxFailure {
  if (!value || typeof value !== "object") return false;
  const { kind, provider, detail } = value as Record<string, unknown>;
  return (
    typeof kind === "string" && FAILURE_KINDS.has(kind)
    && typeof provider === "string" && (SANDBOX_PROVIDERS as readonly string[]).includes(provider)
    && typeof detail === "string"
  );
}

/** The typed body of a control-plane 503, or null for any other response body. */
export function sandboxErrorBody(value: unknown): SandboxErrorBody | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  if (typeof body.requestId !== "string") return null;
  if (body.error === "sandbox_waking") return { error: "sandbox_waking", requestId: body.requestId };
  if (body.error === "sandbox_unavailable" && isFailure(body.failure)) {
    return { error: "sandbox_unavailable", failure: body.failure, requestId: body.requestId };
  }
  return null;
}

const PROVIDER_NAMES: Record<SandboxProviderKind, string> = {
  vercel: "Vercel",
};

export function describeSandboxFailure(failure: SandboxFailure): string {
  switch (failure.kind) {
    case "start_failed":
      return "Your workspace failed to start.";
    case "out_of_capacity":
      return `${PROVIDER_NAMES[failure.provider]} has no room to start your workspace right now.`;
    case "out_of_memory":
      return "Your workspace ran out of memory and stopped.";
    case "crashed":
      return "Your workspace stopped unexpectedly.";
    case "home_missing":
      return "Your workspace's disk could not be found.";
    case "server_failed":
      return "Your workspace started, but Gali did not come up inside it.";
  }
}

export function sandboxProviderName(provider: SandboxProviderKind): string {
  return PROVIDER_NAMES[provider];
}
