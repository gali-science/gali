import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ENSURE_STREAM_TYPE,
  type EnsureStreamLine,
  type WakeProgressPhase,
} from "../../shared/sandbox-health.js";
import { getSession } from "./_lib/auth.js";
import {
  errorFields,
  logOperationalEvent,
  requestId,
} from "./_lib/operational-log.js";
import { sandboxErrorReply, sendSandboxErrorReply } from "./_lib/sandbox-errors.js";
import { retrySandbox } from "./_lib/sandbox-resolve.js";
import { authenticateSandboxToken } from "./_lib/sandbox-gateway-auth.js";
import { sleepUser } from "./_lib/sandbox-sleep.js";
import { withWakeProgress } from "./_lib/wake-progress.js";
import {
  getUserById,
  hasCurrentModelConsent,
} from "./_lib/users.js";

export const config = {
  maxDuration: 300,
};

function bearer(req: VercelRequest): string | null {
  const raw = req.headers.authorization;
  if (typeof raw !== "string" || !raw.startsWith("Bearer ")) return null;
  const token = raw.slice("Bearer ".length).trim();
  return token || null;
}

function opOf(req: VercelRequest): string {
  const raw = req.query.op;
  return Array.isArray(raw) ? (raw[0] ?? "") : typeof raw === "string" ? raw : "";
}

async function handleEnsure(
  req: VercelRequest,
  res: VercelResponse,
  reqId: string,
): Promise<void> {
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }
  const session = await getSession(req);
  if (!session || "denied" in session) {
    res.status(session ? 403 : 401).json({ error: session ? session.denied : "authentication required" });
    return;
  }
  const user = await getUserById(session.userId);
  if (!user || !hasCurrentModelConsent(user)) {
    res.status(403).json({ error: "model consent required" });
    return;
  }
  const startedAt = Date.now();
  logOperationalEvent({
    eventName: "sandbox.wake.started",
    level: "info",
    requestId: reqId,
    userId: session.userId,
  });
  const streaming = String(req.headers.accept ?? "").includes(ENSURE_STREAM_TYPE);
  if (!streaming) {
    const resolved = await retrySandbox(session.userId);
    logWakeCompleted(reqId, session.userId, resolved.sandboxId, startedAt);
    res.status(200).json({ status: "ready", sandboxId: resolved.sandboxId });
    return;
  }

  res.status(200);
  res.setHeader("content-type", ENSURE_STREAM_TYPE);
  res.setHeader("cache-control", "no-cache, no-transform");
  const send = (line: EnsureStreamLine) => res.write(`${JSON.stringify(line)}\n`);
  let lastPhase: WakeProgressPhase | null = null;
  try {
    const resolved = await withWakeProgress((phase) => {
      if (phase === lastPhase) return;
      lastPhase = phase;
      send({ type: "progress", phase });
    }, () => retrySandbox(session.userId));
    logWakeCompleted(reqId, session.userId, resolved.sandboxId, startedAt);
    send({ type: "ready", sandboxId: resolved.sandboxId });
  } catch (error) {
    const reply = sandboxErrorReply(error, reqId);
    logOperationalEvent({
      eventName: "sandbox.wake.failed",
      level: "error",
      requestId: reqId,
      userId: session.userId,
      status: reply?.status ?? 503,
      ...errorFields(error),
    });
    send({
      type: "failed",
      status: reply?.status ?? 503,
      body: reply?.body ?? { error: "sandbox request failed", requestId: reqId },
    });
  }
  res.end();
}

function logWakeCompleted(reqId: string, userId: number, sandboxId: string, startedAt: number): void {
  logOperationalEvent({
    eventName: "sandbox.wake.completed",
    level: "info",
    requestId: reqId,
    userId,
    sandboxId,
    durationMs: Date.now() - startedAt,
  });
}

/** Called by an idle sandbox to put itself to sleep. */
async function handleSleep(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  const token = bearer(req);
  const user = token ? await authenticateSandboxToken(token, "sleep") : null;
  if (!user) {
    res.status(401).json({ error: "invalid sleep token" });
    return;
  }

  const body = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) as {
    sandboxId?: unknown;
  } | null;
  const sandboxId = body?.sandboxId;
  if (typeof sandboxId !== "string" || !sandboxId) {
    res.status(400).json({ error: "sandboxId required" });
    return;
  }

  if (sandboxId !== user.sandboxId) {
    res.status(403).json({ error: "sandboxId does not match token" });
    return;
  }

  await sleepUser(user);
  logOperationalEvent({
    eventName: "sandbox.sleep.completed",
    level: "info",
    userId: user.id,
    sandboxId,
  });
  res.status(200).json({ slept: true, sandboxId });
}

// Hobby plan: one function for ensure / sleep.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const reqId = requestId(req, res);
  try {
    const op = opOf(req);
    if (op === "ensure" || op === "") {
      await handleEnsure(req, res, reqId);
      return;
    }
    if (op === "sleep") {
      await handleSleep(req, res);
      return;
    }
    res.status(404).json({ error: `unknown sandbox op: ${op}` });
  } catch (error) {
    const op = opOf(req);
    const eventName = op === "ensure" || op === ""
      ? "sandbox.wake.failed"
      : op === "sleep"
        ? "sandbox.sleep.failed"
        : "control.request.failed";
    const reply = op === "ensure" || op === "" ? sandboxErrorReply(error, reqId) : null;
    const status = reply?.status ?? (op === "ensure" ? 503 : 500);
    logOperationalEvent({
      eventName,
      level: "error",
      requestId: reqId,
      status,
      ...errorFields(error),
    });
    if (res.headersSent) return;
    if (reply) sendSandboxErrorReply(res, reply);
    else res.status(status).json({ error: "sandbox request failed", requestId: reqId });
  }
}
