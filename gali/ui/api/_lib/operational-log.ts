import crypto from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  OPERATIONAL_EVENT_SCHEMA_VERSION,
  parseOperationalEvent,
  sanitizeErrorMessage,
  type OperationalEvent,
} from "../../../shared/observability/operational-event.js";

export type OperationalEventInput = Omit<
  OperationalEvent,
  "schemaVersion" | "eventId" | "occurredAt" | "source"
> & {
  eventId?: string;
  occurredAt?: string;
  source?: OperationalEvent["source"];
};

export function requestId(
  req: Pick<VercelRequest, "headers">,
  res?: Pick<VercelResponse, "setHeader">,
): string {
  const raw = req.headers?.["x-gali-request-id"];
  const supplied = Array.isArray(raw) ? raw[0] : raw;
  const id = typeof supplied === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
  if (res && typeof res.setHeader === "function") {
    res.setHeader("x-gali-request-id", id);
  }
  return id;
}

export function errorFields(error: unknown): {
  errorCode: string;
  errorMessage: string;
} {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : error instanceof Error
      ? error.name
      : "Error";
  return {
    errorCode: code.slice(0, 80),
    errorMessage: sanitizeErrorMessage(error),
  };
}

export function createOperationalEvent(input: OperationalEventInput): OperationalEvent {
  return parseOperationalEvent({
    ...input,
    schemaVersion: OPERATIONAL_EVENT_SCHEMA_VERSION,
    eventId: input.eventId ?? crypto.randomUUID(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    source: input.source ?? "vercel",
  });
}

export function logOperationalEvent(input: OperationalEventInput): OperationalEvent {
  const event = createOperationalEvent(input);
  const line = JSON.stringify(event);
  if (event.level === "error") console.error(line);
  else if (event.level === "warn") console.warn(line);
  else console.info(line);
  return event;
}

/** One `sandbox.wake.phase` line per step, so a slow wake says which step was slow. */
export async function timeWakePhase<T>(
  phase: string,
  ids: { userId: number; sandboxId?: string },
  run: () => Promise<T>,
  outcome?: (result: T) => string | undefined,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    const status = outcome?.(result);
    logOperationalEvent({
      eventName: "sandbox.wake.phase",
      level: "info",
      phase,
      ...ids,
      durationMs: Date.now() - startedAt,
      ...(status ? { status } : {}),
    });
    return result;
  } catch (error) {
    logOperationalEvent({
      eventName: "sandbox.wake.phase",
      level: "warn",
      phase,
      ...ids,
      durationMs: Date.now() - startedAt,
      status: "failed",
      ...errorFields(error),
    });
    throw error;
  }
}
