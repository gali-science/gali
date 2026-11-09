import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  parseOperationalEvent,
  type OperationalEventName,
} from "../../shared/observability/operational-event.js";
import {
  errorFields,
  logOperationalEvent,
  requestId,
} from "./_lib/operational-log.js";
import { verifyTelemetryToken } from "./_lib/telemetry-token.js";
import { getUserById } from "./_lib/users.js";

const MAX_EVENTS = 20;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;
const SANDBOX_EVENTS = new Set<OperationalEventName>([
  "sandbox.process.started",
  "sandbox.process.crashed",
  "sandbox.http.failed",
  "review.failed",
  "telemetry.delivery.failed",
]);

export const config = {
  maxDuration: 30,
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function bearer(req: VercelRequest): string {
  const raw = req.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) {
    throw new HttpError(401, "telemetry authentication required");
  }
  return raw.slice("Bearer ".length).trim();
}

function eventsFromBody(body: unknown): unknown[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new HttpError(400, "telemetry body must be an object");
  }
  const events = (body as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS) {
    throw new HttpError(400, `telemetry events must contain 1-${MAX_EVENTS} items`);
  }
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
    throw new HttpError(413, "telemetry body is too large");
  }
  return events;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const reqId = requestId(req, res);
  try {
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    const claims = verifyTelemetryToken(bearer(req));
    const user = await getUserById(claims.userId);
    if (!user || user.sandboxId !== claims.sandboxId) {
      throw new HttpError(401, "invalid telemetry token");
    }
    const now = Date.now();
    const events = eventsFromBody(req.body).map((value) => {
      const event = parseOperationalEvent(value);
      if (event.source !== "sandbox" || !SANDBOX_EVENTS.has(event.eventName)) {
        throw new HttpError(400, "telemetry event is not allowed");
      }
      const occurredAt = Date.parse(event.occurredAt);
      if (
        occurredAt < now - MAX_EVENT_AGE_MS
        || occurredAt > now + MAX_FUTURE_MS
      ) {
        throw new HttpError(400, "telemetry event timestamp is outside the allowed window");
      }
      return event;
    });
    for (const event of events) {
      logOperationalEvent({
        ...event,
        requestId: event.requestId ?? reqId,
        userId: user.id,
        sandboxId: claims.sandboxId,
      });
    }
    res.status(202).json({ accepted: events.length });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (!(error instanceof HttpError)) {
      logOperationalEvent({
        eventName: "control.request.failed",
        level: "error",
        requestId: reqId,
        status,
        ...errorFields(error),
      });
    }
    res.status(status).json({
      error: error instanceof HttpError ? error.message : "telemetry ingestion failed",
      requestId: reqId,
    });
  }
}
