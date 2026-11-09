export const OPERATIONAL_EVENT_SCHEMA_VERSION = 1 as const;

export const OPERATIONAL_EVENT_NAMES = [
  "control.request.failed",
  "control.misconfigured",
  "control.proxy.recovered",
  "client.failed",
  "client.boot.completed",
  "client.stream.gap",
  "sandbox.wake.started",
  "sandbox.wake.completed",
  "sandbox.wake.failed",
  "sandbox.wake.phase",
  "sandbox.wake.restored",
  "sandbox.sleep.completed",
  "sandbox.sleep.failed",
  "sandbox.process.started",
  "sandbox.process.crashed",
  "sandbox.http.failed",
  "review.failed",
  "telemetry.delivery.failed",
] as const;

export type OperationalEventName = (typeof OPERATIONAL_EVENT_NAMES)[number];
export type OperationalEventLevel = "info" | "warn" | "error";
export type OperationalEventSource = "vercel" | "sandbox" | "browser";

export type OperationalEvent = {
  schemaVersion: typeof OPERATIONAL_EVENT_SCHEMA_VERSION;
  eventId: string;
  eventName: OperationalEventName;
  occurredAt: string;
  level: OperationalEventLevel;
  source: OperationalEventSource;
  version?: string;
  requestId?: string;
  userId?: number;
  sandboxId?: string;
  projectKey?: string;
  sessionId?: number;
  runId?: string;
  phase?: string;
  durationMs?: number;
  status?: number | string;
  errorCode?: string;
  errorMessage?: string;
};

const EVENT_NAMES = new Set<string>(OPERATIONAL_EVENT_NAMES);
const LEVELS = new Set<string>(["info", "warn", "error"]);
const SOURCES = new Set<string>(["vercel", "sandbox", "browser"]);
const FIELDS = new Set<keyof OperationalEvent>([
  "schemaVersion",
  "eventId",
  "eventName",
  "occurredAt",
  "level",
  "source",
  "version",
  "requestId",
  "userId",
  "sandboxId",
  "projectKey",
  "sessionId",
  "runId",
  "phase",
  "durationMs",
  "status",
  "errorCode",
  "errorMessage",
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("operational event must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  row: Record<string, unknown>,
  key: string,
  max: number,
): string {
  const value = row[key];
  if (typeof value !== "string" || !value || value.length > max) {
    throw new Error(`operational event ${key} is invalid`);
  }
  return value;
}

function optionalString(
  row: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value || value.length > max) {
    throw new Error(`operational event ${key} is invalid`);
  }
  return value;
}

function optionalInteger(
  row: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = row[key];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`operational event ${key} is invalid`);
  }
  return Number(value);
}

export function sanitizeErrorMessage(value: unknown, max = 500): string {
  const message = value instanceof Error ? value.message : String(value);
  const withoutControls = Array.from(message, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : character;
  }).join("");
  return withoutControls
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[REDACTED]")
    .replace(/([?&](?:access_token|api_key|key|signature|sig|token)=)[^&#\s]*/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function parseOperationalEvent(value: unknown): OperationalEvent {
  const row = record(value);
  for (const key of Object.keys(row)) {
    if (!FIELDS.has(key as keyof OperationalEvent)) {
      throw new Error(`operational event field '${key}' is not allowed`);
    }
  }
  if (row.schemaVersion !== OPERATIONAL_EVENT_SCHEMA_VERSION) {
    throw new Error("operational event schemaVersion is invalid");
  }
  const eventName = requiredString(row, "eventName", 80);
  if (!EVENT_NAMES.has(eventName)) throw new Error("operational event name is not allowed");
  const level = requiredString(row, "level", 8);
  if (!LEVELS.has(level)) throw new Error("operational event level is invalid");
  const source = requiredString(row, "source", 12);
  if (!SOURCES.has(source)) throw new Error("operational event source is invalid");
  const occurredAt = requiredString(row, "occurredAt", 40);
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new Error("operational event occurredAt is invalid");
  }
  const status = row.status;
  if (
    status !== undefined
    && typeof status !== "string"
    && (!Number.isSafeInteger(status) || Number(status) < 0)
  ) {
    throw new Error("operational event status is invalid");
  }
  return {
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    eventId: requiredString(row, "eventId", 64),
    eventName: eventName as OperationalEventName,
    occurredAt,
    level: level as OperationalEventLevel,
    source: source as OperationalEventSource,
    ...(optionalString(row, "version", 64) ? { version: String(row.version) } : {}),
    ...(optionalString(row, "requestId", 64) ? { requestId: String(row.requestId) } : {}),
    ...(optionalInteger(row, "userId") === undefined ? {} : { userId: Number(row.userId) }),
    ...(optionalString(row, "sandboxId", 128) ? { sandboxId: String(row.sandboxId) } : {}),
    ...(optionalString(row, "projectKey", 128) ? { projectKey: String(row.projectKey) } : {}),
    ...(optionalInteger(row, "sessionId") === undefined
      ? {}
      : { sessionId: Number(row.sessionId) }),
    ...(optionalString(row, "runId", 128) ? { runId: String(row.runId) } : {}),
    ...(optionalString(row, "phase", 64) ? { phase: String(row.phase) } : {}),
    ...(optionalInteger(row, "durationMs") === undefined
      ? {}
      : { durationMs: Number(row.durationMs) }),
    ...(status === undefined ? {} : { status: status as number | string }),
    ...(optionalString(row, "errorCode", 80) ? { errorCode: String(row.errorCode) } : {}),
    ...(optionalString(row, "errorMessage", 500)
      ? { errorMessage: sanitizeErrorMessage(row.errorMessage) }
      : {}),
  };
}
