import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSession } from "./_lib/auth.js";
import {
  errorFields,
  logOperationalEvent,
  requestId,
} from "./_lib/operational-log.js";
import {
  forgetCached,
  resolveSandbox,
  routeSandbox,
  type ResolvedSandbox,
} from "./_lib/sandbox-resolve.js";
import { sandboxErrorReply, sendSandboxErrorReply } from "./_lib/sandbox-errors.js";
import { sandboxHttpHeaders } from "./_lib/sandbox-http-auth.js";

export const config = {
  api: { bodyParser: false },
  // A request that finds the sandbox asleep wakes it, and a wake may install a release whose
  // lockfile changed (a full pnpm install); cut off at 60s it leaves the wake claim held.
  maxDuration: 300,
};

export const EVENT_STREAM_MAX_MS = 55_000;

async function readBody(req: VercelRequest): Promise<ArrayBuffer | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<unknown>) {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      chunks.push(Buffer.from(chunk));
    } else {
      throw new TypeError("request body contained a non-byte chunk");
    }
  }
  if (chunks.length === 0) return undefined;
  const buf = Buffer.concat(chunks);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function galiSuffix(req: VercelRequest): { path: string; search: string } {
  const raw = req.query.galiPath;
  const path = Array.isArray(raw) ? raw.join("/") : typeof raw === "string" ? raw : "";
  const url = new URL(req.url ?? "/", "http://localhost");
  url.searchParams.delete("galiPath");
  return { path, search: url.search };
}

function retryableMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function gatewayFailure(status: number): boolean {
  return status === 502 || status === 503 || status === 504;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const reqId = requestId(req, res);
  try {
    // Before resolveSandbox: an unauthenticated caller must not be able to reach
    // the sandbox provider at all, let alone wake a sandbox.
    const session = await getSession(req);
    if (!session || "denied" in session) {
      res.status(session ? 403 : 401).json({ error: session ? session.denied : "authentication required" });
      return;
    }

    let resolved = await routeSandbox(session.userId);
    const { path, search } = galiSuffix(req);

    const body = await readBody(req);
    const headers = new Headers();
    headers.set("x-gali-request-id", reqId);
    const contentType = req.headers["content-type"];
    if (contentType) headers.set("content-type", contentType);
    const forward = (destination: ResolvedSandbox) => {
      const destinationHeaders = new Headers(headers);
      for (const [name, value] of Object.entries(
        sandboxHttpHeaders(session.userId, destination.sandboxId),
      )) {
        destinationHeaders.set(name, value);
      }
      return (
      fetch(`${destination.host}/${path}${search}`, {
        method: req.method,
        headers: destinationHeaders,
        body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      })
      );
    };

    const logRecovered = (cause: string, startedAt: number, status: number | string) => logOperationalEvent({
      eventName: "control.proxy.recovered",
      level: "warn",
      requestId: reqId,
      userId: session.userId,
      sandboxId: resolved.sandboxId,
      phase: cause,
      durationMs: Date.now() - startedAt,
      status,
      errorMessage: `${req.method} /${path}`,
    });

    let upstream: Response;
    try {
      upstream = await forward(resolved);
    } catch (error) {
      const startedAt = Date.now();
      forgetCached(session.userId);
      resolved = await resolveSandbox(session.userId);
      if (!retryableMethod(req.method)) {
        logRecovered("connect-error", startedAt, "not-replayed");
        throw new Error(
          `sandbox connection recovered; retry the request (${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
      upstream = await forward(resolved);
      logRecovered("connect-error", startedAt, upstream.status);
    }

    if (gatewayFailure(upstream.status)) {
      // Verify/recover only after the direct route reports a gateway failure.
      // Never replay a mutation: the upstream may have applied it before its
      // response was lost, and duplicating it would be unsafe.
      const startedAt = Date.now();
      const cause = `gateway-${upstream.status}`;
      forgetCached(session.userId);
      resolved = await resolveSandbox(session.userId);
      if (retryableMethod(req.method)) upstream = await forward(resolved);
      logRecovered(cause, startedAt, retryableMethod(req.method) ? upstream.status : "not-replayed");
    }

    res.status(upstream.status);
    // Sandbox files are served from the app's own origin. Opened directly, an
    // SVG or HTML file would otherwise run its scripts with the user's session.
    res.setHeader("content-security-policy", "sandbox; default-src 'none'");
    res.setHeader("x-content-type-options", "nosniff");
    for (const key of ["content-type", "cache-control", "content-disposition", "content-length"]) {
      const value = upstream.headers.get(key);
      if (value) res.setHeader(key, value);
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    const reader = upstream.body.getReader();
    const streamCutoff = path === "events"
      ? setTimeout(() => void reader.cancel("Vercel stream cutoff"), EVENT_STREAM_MAX_MS)
      : null;
    streamCutoff?.unref();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    } finally {
      if (streamCutoff) clearTimeout(streamCutoff);
    }
    res.end();
  } catch (error) {
    const reply = sandboxErrorReply(error, reqId);
    logOperationalEvent({
      eventName: "control.request.failed",
      level: "error",
      requestId: reqId,
      status: reply?.status ?? 502,
      ...errorFields(error),
    });
    if (res.headersSent) return;
    if (reply) sendSandboxErrorReply(res, reply);
    else res.status(502).json({ error: "sandbox proxy failed", requestId: reqId });
  }
}
