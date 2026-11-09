import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GALI_CONFIG } from "../../shared/config.js";
import type { OperationalEventName } from "../../shared/observability/operational-event.js";
import { getSession } from "./_lib/auth.js";
import {
  errorFields,
  logOperationalEvent,
  requestId,
} from "./_lib/operational-log.js";
import { summarizeTranscript } from "./_lib/memory-summarize.js";
import { pricingHealth } from "./_lib/pricing.js";
import { recordUsageWithRetry, trialStatus } from "./_lib/trial.js";
import {
  acceptModelConsentById,
  getUserById,
  hasCurrentModelConsent,
  MODEL_CONSENT_VERSION,
} from "./_lib/users.js";
import {
  getVoiceMemoryRow,
  saveVoiceMemoryInput,
  saveVoiceMemorySummary,
} from "./_lib/voice-memory.js";

// The memory op can spend up to ~20s on the one-shot summarize call.
export const config = {
  maxDuration: 30,
};

function opOf(req: VercelRequest): string {
  const raw = req.query.op;
  return Array.isArray(raw) ? (raw[0] ?? "") : typeof raw === "string" ? raw : "";
}

async function handleMe(req: VercelRequest, res: VercelResponse): Promise<void> {
  const session = await getSession(req);
  if (!session || "denied" in session) {
    res.status(session ? 403 : 401).json({ error: session ? session.denied : "authentication required" });
    return;
  }

  if (req.method === "GET") {
    const user = await getUserById(session.userId);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    res.status(200).json({
      displayName: user.displayName,
      identityEmail: user.identityEmail,
      trial: trialStatus(user),
    });
    return;
  }

  res.status(405).json({ error: "method not allowed" });
}

async function handleMemory(
  req: VercelRequest,
  res: VercelResponse,
  reqId: string,
): Promise<void> {
  const session = await getSession(req);
  if (!session || "denied" in session) {
    res.status(session ? 403 : 401).json({ error: session ? session.denied : "authentication required" });
    return;
  }

  if (req.method === "GET") {
    const user = await getUserById(session.userId);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    const row = await getVoiceMemoryRow(session.userId);
    if (!row) {
      res.status(200).json(null);
      return;
    }
    const stale =
      row.transcript.trim() !== "" &&
      row.transcriptAt !== null &&
      (row.summarizedAt === null || row.summarizedAt < row.transcriptAt);
    const summary = stale
      ? row.transcript.trim() || row.summary.trim()
      : row.summary.trim() || row.transcript.trim();
    if (stale && row.transcriptAt) {
      const transcriptAt = row.transcriptAt;
      void summarizeTranscript({
        transcript: row.transcript,
        previousSummary: row.summary,
      })
        .then(async (next) => {
          if (next.usage) {
            try {
              await recordUsageWithRetry({
                userId: session.userId,
                source: "memory",
                externalId: next.responseId,
                model: next.model,
                usage: next.usage,
              });
            } catch (error) {
              logOperationalEvent({
                eventName: "control.request.failed",
                level: "error",
                requestId: reqId,
                userId: session.userId,
                status: "memory-usage",
                ...errorFields(error),
              });
            }
          }
          await saveVoiceMemorySummary(session.userId, next.summary, transcriptAt);
        })
        .catch((error) => {
          logOperationalEvent({
            eventName: "control.request.failed",
            level: "error",
            requestId: reqId,
            userId: session.userId,
            status: "memory-summarize",
            ...errorFields(error),
          });
        });
    }
    const endedAt = row.transcriptAt ?? row.updatedAt;
    res.status(200).json({
      summary,
      uiLocation: row.uiLocation,
      endedAt: endedAt.toISOString(),
    });
    return;
  }

  if (req.method === "POST") {
    const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
      transcript?: unknown;
      uiLocation?: unknown;
    } | null;
    const transcript = body?.transcript;
    const uiLocation = body?.uiLocation;
    if (transcript !== undefined && typeof transcript !== "string") {
      res.status(400).json({ error: "transcript must be a string" });
      return;
    }
    if (uiLocation !== undefined && typeof uiLocation !== "string") {
      res.status(400).json({ error: "uiLocation must be a string" });
      return;
    }
    if (transcript === undefined && uiLocation === undefined) {
      res.status(400).json({ error: "transcript or uiLocation required" });
      return;
    }
    await saveVoiceMemoryInput(session.userId, { transcript, uiLocation });
    res.status(200).json({ ok: true });
    return;
  }

  res.status(405).json({ error: "method not allowed" });
}

async function handleUsage(req: VercelRequest, res: VercelResponse): Promise<void> {
  const session = await getSession(req);
  if (!session || "denied" in session) {
    res.status(session ? 403 : 401).json({ error: session ? session.denied : "authentication required" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
    kind?: unknown;
    externalId?: unknown;
    usage?: unknown;
  } | null;
  if (body?.kind !== "response" && body?.kind !== "transcription") {
    res.status(400).json({ error: "kind must be response or transcription" });
    return;
  }
  if (
    typeof body.externalId !== "string"
    || !body.externalId.trim()
    || body.externalId.length > 256
  ) {
    res.status(400).json({ error: "externalId is required" });
    return;
  }
  if (!body.usage || typeof body.usage !== "object" || Array.isArray(body.usage)) {
    res.status(400).json({ error: "usage must be an object" });
    return;
  }
  const transcription = body.kind === "transcription";
  const model = transcription
    ? GALI_CONFIG.realtime.transcribeModel
    : GALI_CONFIG.realtime.model;
  const trial = await recordUsageWithRetry({
    userId: session.userId,
    source: transcription ? "transcription" : "realtime",
    externalId: body.externalId.trim(),
    model,
    usage: body.usage as Record<string, unknown>,
  });
  res.status(200).json({ trial });
}

function consentDto(user: NonNullable<Awaited<ReturnType<typeof getUserById>>>) {
  const accepted = hasCurrentModelConsent(user);
  return {
    version: MODEL_CONSENT_VERSION,
    accepted,
    voiceOpenAiAccepted: accepted,
    experimentsTogetherAccepted: accepted,
    acceptedAt: accepted ? user.consentAcceptedAt?.toISOString() ?? null : null,
  };
}

async function handleConsent(req: VercelRequest, res: VercelResponse): Promise<void> {
  const session = await getSession(req);
  if (!session || "denied" in session) {
    res.status(session ? 403 : 401).json({ error: session ? session.denied : "authentication required" });
    return;
  }
  const user = await getUserById(session.userId);
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  if (req.method === "GET") {
    res.status(200).json(consentDto(user));
    return;
  }
  if (req.method === "POST") {
    const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
      voiceOpenAiAccepted?: unknown;
      experimentsTogetherAccepted?: unknown;
    } | null;
    if (
      body?.voiceOpenAiAccepted !== true
      || body.experimentsTogetherAccepted !== true
    ) {
      res.status(400).json({ error: "both model disclosures must be accepted" });
      return;
    }
    const accepted = await acceptModelConsentById(
      session.userId,
      MODEL_CONSENT_VERSION,
    );
    res.status(200).json(consentDto(accepted));
    return;
  }
  res.status(405).json({ error: "method not allowed" });
}

async function handleClientError(
  req: VercelRequest,
  res: VercelResponse,
  reqId: string,
): Promise<void> {
  const session = await getSession(req);
  if (!session || "denied" in session) {
    res.status(session ? 403 : 401).json({ error: session ? session.denied : "authentication required" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
    errorCode?: unknown;
    errorMessage?: unknown;
  } | null;
  if (typeof body?.errorCode !== "string" || typeof body.errorMessage !== "string") {
    res.status(400).json({ error: "errorCode and errorMessage are required" });
    return;
  }
  logOperationalEvent({
    eventName: "client.failed",
    level: "error",
    source: "browser",
    requestId: reqId,
    userId: session.userId,
    errorCode: body.errorCode,
    errorMessage: body.errorMessage,
  });
  res.status(202).json({ accepted: true });
}

const CLIENT_EVENTS = new Set<OperationalEventName>(["client.boot.completed", "client.stream.gap"]);

async function handleClientEvent(
  req: VercelRequest,
  res: VercelResponse,
  reqId: string,
): Promise<void> {
  const session = await getSession(req);
  if (!session || "denied" in session) {
    res.status(session ? 403 : 401).json({ error: session ? session.denied : "authentication required" });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
    eventName?: unknown;
    phase?: unknown;
    durationMs?: unknown;
    status?: unknown;
  } | null;
  const eventName = body?.eventName as OperationalEventName;
  if (!CLIENT_EVENTS.has(eventName)) {
    res.status(400).json({ error: "client event is not allowed" });
    return;
  }
  const event = logOperationalEvent({
    eventName,
    level: eventName === "client.stream.gap" ? "warn" : "info",
    source: "browser",
    requestId: reqId,
    userId: session.userId,
    ...(body!.phase === undefined ? {} : { phase: body!.phase as string }),
    ...(body!.durationMs === undefined ? {} : { durationMs: body!.durationMs as number }),
    ...(body!.status === undefined ? {} : { status: body!.status as string | number }),
  });
  res.status(202).json({ accepted: event.eventId });
}

// Hobby plan: one function for /api/me, /api/health, /api/memory, and /api/usage.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const reqId = requestId(req, res);
  try {
    const op = opOf(req);
    if (op === "health") {
      // Public endpoint: which setting is missing goes to the log, never the response.
      const missing = [
        ...(process.env.TOGETHER_API_KEY ? [] : ["TOGETHER_API_KEY"]),
        ...(process.env.GALI_SANDBOX_HTTP_MASTER_KEY ? [] : ["GALI_SANDBOX_HTTP_MASTER_KEY"]),
        ...pricingHealth().missing.map((price) => `price ${price}`),
      ];
      if (missing.length > 0) {
        logOperationalEvent({
          eventName: "control.misconfigured",
          level: "error",
          requestId: reqId,
          errorMessage: `missing: ${missing.join(", ")}`,
        });
      }
      res.status(missing.length > 0 ? 503 : 200).json({ ok: missing.length === 0 });
      return;
    }
    if (op === "memory") {
      await handleMemory(req, res, reqId);
      return;
    }
    if (op === "usage") {
      await handleUsage(req, res);
      return;
    }
    if (op === "consent") {
      await handleConsent(req, res);
      return;
    }
    if (op === "client-error") {
      await handleClientError(req, res, reqId);
      return;
    }
    if (op === "client-event") {
      await handleClientEvent(req, res, reqId);
      return;
    }
    if (op === "me" || op === "") {
      await handleMe(req, res);
      return;
    }
    res.status(404).json({ error: `unknown account op: ${op}` });
  } catch (error) {
    logOperationalEvent({
      eventName: "control.request.failed",
      level: "error",
      requestId: reqId,
      status: 500,
      ...errorFields(error),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: "account request failed", requestId: reqId });
    }
  }
}
