import crypto from "node:crypto";
import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  parseOperationalEvent,
  sanitizeErrorMessage,
  type OperationalEvent,
  type OperationalEventName,
} from "../../shared/observability/operational-event.js";

type SandboxEventInput = {
  eventName: OperationalEventName;
  level: "info" | "warn" | "error";
  requestId?: string;
  projectKey?: string;
  sessionId?: number;
  runId?: string;
  durationMs?: number;
  status?: number | string;
  errorCode?: string;
  errorMessage?: string;
};

type SenderConfig = {
  url: string;
  token: string;
  sandboxId: string;
  version?: string;
  fetchImpl: typeof fetch;
};

let sender: SenderConfig | null = null;

export function configureOperationalLogger(opts: {
  url?: string;
  token?: string;
  sandboxId?: string;
  version?: string;
  fetchImpl?: typeof fetch;
}): void {
  const url = opts.url?.trim();
  const token = opts.token?.trim();
  const sandboxId = opts.sandboxId?.trim();
  if (!url && !token) {
    sender = null;
    return;
  }
  if (!url || !token || !sandboxId) {
    throw new Error(
      "GALI_TELEMETRY_URL, GALI_TELEMETRY_TOKEN, and GALI_SANDBOX_ID must be set together",
    );
  }
  sender = {
    url,
    token,
    sandboxId,
    ...(opts.version?.trim() ? { version: opts.version.trim() } : {}),
    fetchImpl: opts.fetchImpl ?? fetch,
  };
}

function event(input: SandboxEventInput): OperationalEvent {
  return parseOperationalEvent({
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    eventName: input.eventName,
    occurredAt: new Date().toISOString(),
    level: input.level,
    source: "sandbox",
    ...(sender?.version ? { version: sender.version } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.projectKey ? { projectKey: input.projectKey } : {}),
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(input.errorMessage
      ? { errorMessage: sanitizeErrorMessage(input.errorMessage) }
      : {}),
  });
}

async function send(item: OperationalEvent): Promise<void> {
  if (!sender) return;
  const waits = [0, 250];
  let lastStatus = 0;
  for (const wait of waits) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const response = await sender.fetchImpl(sender.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sender.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events: [item] }),
        signal: AbortSignal.timeout(3_000),
      });
      lastStatus = response.status;
      if (response.ok) return;
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch {
      lastStatus = 0;
    }
  }
  const failed = event({
    eventName: "telemetry.delivery.failed",
    level: "warn",
    status: lastStatus || "network",
  });
  console.warn(JSON.stringify(failed));
}

export function logSandboxEvent(input: SandboxEventInput): OperationalEvent {
  const item = event(input);
  const line = JSON.stringify(item);
  if (item.level === "error") console.error(line);
  else if (item.level === "warn") console.warn(line);
  else console.info(line);
  void send(item);
  return item;
}

export function operationalErrorFields(error: unknown): {
  errorCode: string;
  errorMessage: string;
} {
  const errorCode = error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : error instanceof Error
      ? error.name
      : "Error";
  return {
    errorCode: errorCode.slice(0, 80),
    errorMessage: sanitizeErrorMessage(error),
  };
}
