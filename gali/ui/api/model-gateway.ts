import type { VercelRequest, VercelResponse } from "@vercel/node";
import { randomUUID } from "node:crypto";
import { GALI_CONFIG } from "../../shared/config.js";
import { recordUsageWithRetry, trialStatus, type UsageSource } from "./_lib/trial.js";
import type { User } from "./_lib/db/schema.js";
import { checkModelPrice, type UsageRecord } from "./_lib/pricing.js";
import { authenticateSandboxToken } from "./_lib/sandbox-gateway-auth.js";
import {
  errorFields,
  logOperationalEvent,
  requestId,
} from "./_lib/operational-log.js";
import {
  readTogetherLinkUsage,
  TOGETHERLINK_CODEX_MODEL,
  TOGETHERLINK_FAST_MODEL,
  togetherLinkCostMicros,
  togetherLinkResponsesUrl,
  togetherLinkUsageRecord,
  useTogetherLink,
} from "./_lib/togetherlink.js";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export const config = {
  api: { bodyParser: false },
  maxDuration: 300,
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is not set`);
  return value.trim();
}

function gatewayPath(req: VercelRequest): string {
  const raw = req.query.gatewayPath;
  return (Array.isArray(raw) ? raw.join("/") : typeof raw === "string" ? raw : "")
    .replace(/^\/+/, "");
}

function allowedModels(path: string): string[] {
  if (path === "v1/responses") {
    return useTogetherLink()
      ? [TOGETHERLINK_CODEX_MODEL, TOGETHERLINK_FAST_MODEL]
      : [GALI_CONFIG.codexModel, GALI_CONFIG.fastModel];
  }
  if (path === "v1/realtime/client_secrets") {
    return [GALI_CONFIG.realtime.model];
  }
  throw new HttpError(404, "unsupported model gateway path");
}

async function readBody(req: VercelRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<unknown>) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
      throw new HttpError(400, "request body contained a non-byte chunk");
    }
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "request body is too large");
    chunks.push(bytes);
  }
  if (total === 0) throw new HttpError(400, "request body is required");
  return Buffer.concat(chunks);
}

// Past this a leaked voice key outlives the session it was minted for.
const MAX_REALTIME_SECRET_SECONDS = 600;  

function requestModel(path: string, body: Buffer): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  // A background response finishes after this request ends, so its usage is never metered.
  if (path === "v1/responses" && record.background !== undefined && record.background !== false) {
    throw new HttpError(400, "background responses are not allowed");
  }
  if (path === "v1/realtime/client_secrets" && record.expires_after !== undefined) {
    const expiry = record.expires_after as { anchor?: unknown; seconds?: unknown } | null;
    if (
      expiry?.anchor !== "created_at"
      || typeof expiry.seconds !== "number"
      || expiry.seconds > MAX_REALTIME_SECRET_SECONDS
    ) {
      throw new HttpError(400, `realtime secrets may last at most ${MAX_REALTIME_SECRET_SECONDS}s`);
    }
  }
  const model = path === "v1/realtime/client_secrets"
    ? (record.session as Record<string, unknown> | null | undefined)?.model
    : record.model;
  if (typeof model !== "string" || !model.trim()) {
    throw new HttpError(400, "model is required");
  }
  return model.trim();
}

async function authenticate(req: VercelRequest): Promise<User> {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    throw new HttpError(401, "model gateway authentication required");
  }
  const user = await authenticateSandboxToken(
    authorization.slice("Bearer ".length).trim(),
    "model",
  );
  if (!user) throw new HttpError(401, "invalid model gateway token");
  return user;
}

type MeteredUsage = {
  externalId?: string;
  usage?: UsageRecord;
  model?: string;
  costMicrosOverride?: number;
};

function asRecord(value: unknown): UsageRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as UsageRecord;
}

function inspectSseEvent(block: string, metered: MeteredUsage): void {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return;
  try {
    const event = JSON.parse(data) as Record<string, unknown>;
    const response = asRecord(event.response);
    if (typeof response?.id === "string") metered.externalId = response.id;
    const usage = asRecord(response?.usage);
    if (!usage) return;
    metered.usage = usage;
  } catch {
  }
}

async function forward(
  path: string,
  body: Buffer,
  model: string,
  res: VercelResponse,
): Promise<MeteredUsage> {
  const togetherLink = path === "v1/responses" && useTogetherLink();
  const sessionId = togetherLink ? randomUUID() : null;
  const startedAt = Date.now();
  const apiKey = requireEnv(togetherLink ? "TOGETHER_API_KEY" : "OPENAI_API_KEY");
  const upstream = await fetch(
    togetherLink ? togetherLinkResponsesUrl() : `https://api.openai.com/${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(sessionId ? { "x-togetherlink-session-id": sessionId } : {}),
      },
      body: (togetherLink
        ? rewriteModel(body, model)
        : body) as unknown as BodyInit,
    },
  );
  res.status(upstream.status);
  for (const header of ["content-type", "cache-control"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  if (!upstream.body) {
    res.end();
    return {};
  }
  const contentType = upstream.headers.get("content-type") ?? "";
  const eventStream = contentType.includes("text/event-stream");
  const requestId = upstream.headers.get("x-request-id");
  const metered: MeteredUsage = requestId ? { externalId: requestId } : {};
  const buffered: Buffer[] = [];
  const decoder = new TextDecoder();
  let pending = "";
  const reader = upstream.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    res.write(chunk);
    if (!upstream.ok) continue;
    if (!eventStream) {
      buffered.push(chunk);
      continue;
    }
    pending += decoder.decode(value, { stream: true });
    const blocks = pending.split(/\r?\n\r?\n/);
    pending = blocks.pop() ?? "";
    for (const block of blocks) inspectSseEvent(block, metered);
  }
  res.end();
  if (!upstream.ok) return {};
  if (eventStream) {
    pending += decoder.decode();
    if (pending.trim()) inspectSseEvent(pending, metered);
  } else {
    try {
      const data = JSON.parse(Buffer.concat(buffered).toString("utf8")) as Record<string, unknown>;
      metered.usage = asRecord(data.usage);
      if (typeof data.id === "string") metered.externalId = data.id;
    } catch {
    }
  }
  if (sessionId) {
    const usage = await readTogetherLinkUsage({
      apiKey,
      sessionId,
      since: startedAt,
    });
    metered.model = model;
    metered.usage = togetherLinkUsageRecord(usage);
    metered.costMicrosOverride = togetherLinkCostMicros(usage);
  }
  return metered;
}

function rewriteModel(body: Buffer, model: string): Buffer {
  const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...parsed, model }), "utf8");
}

function exhaustedError() {
  const message = "Your trial is spent.";
  return new HttpError(402, message, {
    error: {
      message,
      type: "trial_exhausted",
      code: "trial_exhausted",
    },
  });
}

function usageSource(path: string): UsageSource | null {
  if (path === "v1/responses") return "responses";
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const reqId = requestId(req, res);
  try {
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    const path = gatewayPath(req);
    const allowed = allowedModels(path);
    const user = await authenticate(req);
    const body = await readBody(req);
    const model = requestModel(path, body);
    if (!allowed.includes(model)) throw new HttpError(403, "model is not allowed");
    if (path === "v1/responses" && trialStatus(user).status === "exhausted") {
      throw exhaustedError();
    }
    if (path === "v1/responses" && !useTogetherLink()) {
      checkModelPrice(model, "responses");
    }
    if (path === "v1/realtime/client_secrets") {
      checkModelPrice(model, "realtime");
      checkModelPrice(GALI_CONFIG.realtime.transcribeModel, "transcription");
    }
    const metered = await forward(path, body, model, res);
    const source = usageSource(path);
    if (source && metered.usage) {
      try {
        await recordUsageWithRetry({
          userId: user.id,
          source,
          externalId: metered.externalId,
          model: metered.model ?? model,
          usage: metered.usage,
          ...(metered.costMicrosOverride === undefined
            ? {}
            : { costMicrosOverride: metered.costMicrosOverride }),
        });
      } catch (error) {
        logOperationalEvent({
          eventName: "control.request.failed",
          level: "error",
          requestId: reqId,
          userId: user.id,
          status: "usage-recording",
          ...errorFields(error),
        });
      }
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 502;
    if (!(error instanceof HttpError)) {
      logOperationalEvent({
        eventName: "control.request.failed",
        level: "error",
        requestId: reqId,
        status,
        ...errorFields(error),
      });
    }
    if (!res.headersSent) {
      res.status(status).json(
        error instanceof HttpError && error.body
          ? error.body
          : {
              error: error instanceof HttpError ? error.message : "model gateway failed",
              requestId: reqId,
            },
      );
    }
  }
}
