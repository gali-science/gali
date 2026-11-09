import crypto from "node:crypto";
import http from "node:http";
import {
  isPdfAnnotationExportFormat,
  PDF_ANNOTATION_COLORS,
  PDF_ANNOTATION_EXPORT_FORMATS,
  type NavEvent,
  type PdfAnnotationColor,
  type ProjectEvent,
  type ReviewProgressEvent,
  type ReviewerEvent,
} from "../../shared/domain/contracts.js";
import { mintRealtimeToken, RealtimeTokenError } from "../adapters/openai/realtime-token.js";
import type { AppContext } from "../application/app-context.js";
import { UserError } from "../lib/user-error.js";
import { IMPORT_UPLOAD_MAX_CHUNK_BYTES } from "../services/projects/import-upload-service.js";
import { requirePaperPath } from "../services/projects/project-service.js";
import { dispatchVoiceTool } from "../voice/tools/dispatch.js";
import { createToolRegistry } from "../voice/tools/registry.js";
import { logSandboxEvent, operationalErrorFields } from "../observability/operational-logger.js";
import type { ActivityTracker } from "./idle-sleep.js";

// None of these say a person is present: /health is a liveness probe, and
// /events plus its /events/recent catch-up are subscriptions the client
// re-establishes on its own. Counting any would hold the sandbox awake forever.
const NON_ACTIVITY_PATHS = new Set(["/health", "/events", "/events/recent"]);

const REPLAY_BUFFER_MAX = 200;
const REPLAY_BUFFER_MS = 30 * 60 * 1000;
const SSE_HEARTBEAT_MS = 15_000;

type SseClient = {
  write: (chunk: string) => void;
  end: () => void;
};

export type GaliHttpServer = {
  port: number;
  publishReviewer: (event: ReviewerEvent) => void;
  publishProject: (event: ProjectEvent) => void;
  publishNav: (event: NavEvent) => void;
  /** Not replayed: a missed line is caught up from /projects/:key/review/progress. */
  publishProgress: (event: ReviewProgressEvent) => void;
  close: () => Promise<void>;
};

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-gali-secret",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  };
}

/**
 * The sandbox's HTTP port is published on a public hostname with no auth of its
 * own, so this shared secret is the only thing standing between the internet
 * and a user's data. It is compared in constant time, and accepted from the
 * query string as well because EventSource cannot set headers.
 *
 * Null is an unprotected server, so it is refused on anything but loopback.
 */
function secretGate(
  secret: string | null,
  host: string,
): (req: http.IncomingMessage, url: URL) => boolean {
  if (secret === null) {
    if (host !== "127.0.0.1") throw new Error(`refusing to serve ${host} without an HTTP secret`);
    return () => true;
  }
  const expected = secret.trim();
  if (!expected) throw new Error("HTTP secret is empty");
  const expectedBytes = Buffer.from(expected);
  return (req, url) => {
    const header = req.headers["x-gali-secret"];
    const provided = typeof header === "string" ? header : (url.searchParams.get("secret") ?? "");
    const providedBytes = Buffer.from(provided);
    return (
      providedBytes.length === expectedBytes.length &&
      crypto.timingSafeEqual(providedBytes, expectedBytes)
    );
  };
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...corsHeaders(),
  });
  res.end(payload);
}

function bytes(res: http.ServerResponse, contentType: string, data: Uint8Array, filename?: string) {
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(data.byteLength),
    ...(filename
      ? { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}` }
      : {}),
    ...corsHeaders(),
  });
  res.end(data);
}

function readRaw(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new UserError(`request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const raw = (await readRaw(req, 1024 * 1024)).toString("utf8");
  if (!raw) throw new UserError("request body required");
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new UserError("request body is not JSON");
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UserError(`${name} is required`);
  return value;
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new UserError(`${name} must be a non-negative integer`);
  return value;
}

function match(pathname: string, pattern: string): Record<string, string> | null {
  const a = pathname.split("/").filter(Boolean);
  const b = pattern.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const part = b[i]!;
    if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(a[i]!);
    else if (part !== a[i]) return null;
  }
  return params;
}

export function createGaliHttpServer(
  app: AppContext,
  opts: {
    port: number;
    host?: string;
    secret: string | null;
    activity: ActivityTracker;
    sseHeartbeatMs?: number;
  },
): Promise<GaliHttpServer> {
  const host = opts.host ?? "0.0.0.0";
  const activity = opts.activity;
  const sse = new Set<SseClient>();
  const broadcast = (event: string, data: unknown) => {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sse) client.write(chunk);
  };

  // The reviewer's answer and file refreshes ride these; a stream gap must not
  // lose them for good, so the client replays from its last seq.
  let eventSeq = 0;
  const replayBuffer: Array<{
    seq: number;
    at: number;
    kind: "reviewer" | "project";
    event: ReviewerEvent | ProjectEvent;
  }> = [];
  const pruneReplayBuffer = () => {
    const cutoff = Date.now() - REPLAY_BUFFER_MS;
    while (
      replayBuffer.length > REPLAY_BUFFER_MAX ||
      (replayBuffer.length > 0 && replayBuffer[0]!.at < cutoff)
    ) {
      replayBuffer.shift();
    }
  };
  const publishReplayable = (kind: "reviewer" | "project", event: ReviewerEvent | ProjectEvent) => {
    const seq = ++eventSeq;
    replayBuffer.push({ seq, at: Date.now(), kind, event });
    pruneReplayBuffer();
    broadcast(kind, { ...event, seq });
  };

  const allowed = secretGate(opts.secret, host);

  async function route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    url: URL,
  ): Promise<void> {
    const path = url.pathname;

    if (method === "GET" && path === "/health") {
      json(res, 200, { ok: true, version: process.env.GALI_BACKEND_VERSION?.trim() || null });
      return;
    }

    if (method === "GET" && path === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...corsHeaders(),
      });
      res.write(`event: ready\ndata: {}\n\n`);
      const client: SseClient = {
        write: (chunk) => res.write(chunk),
        end: () => res.end(),
      };
      sse.add(client);
      const heartbeat = setInterval(() => res.write(": ping\n\n"), opts.sseHeartbeatMs ?? SSE_HEARTBEAT_MS);
      req.on("close", () => {
        clearInterval(heartbeat);
        sse.delete(client);
      });
      return;
    }

    if (method === "GET" && path === "/events/recent") {
      pruneReplayBuffer();
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw === null ? null : Number(sinceRaw);
      const missed = since === null || !Number.isFinite(since)
        ? []
        : replayBuffer.filter((entry) => entry.seq > since);
      json(res, 200, {
        latest: eventSeq,
        reviewer: missed.filter((entry) => entry.kind === "reviewer").map((entry) => ({ ...entry.event, seq: entry.seq })),
        projects: missed.filter((entry) => entry.kind === "project").map((entry) => ({ ...entry.event, seq: entry.seq })),
      });
      return;
    }

    if (method === "GET" && path === "/projects") {
      json(res, 200, await app.visibleProjects());
      return;
    }

    {
      const params = match(path, "/projects/:key");
      if (params && method === "GET") {
        json(res, 200, await app.projects.get(params.key!));
        return;
      }
      if (params && method === "DELETE") {
        const body = await readJson<{ confirmTitle?: unknown }>(req);
        json(res, 200, await app.deleteProject({
          projectKey: params.key!,
          confirmTitle: requireString(body.confirmTitle, "confirmTitle"),
        }));
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/tree");
      if (method === "GET" && params) {
        json(res, 200, await app.projects.tree(params.key!, url.searchParams.get("path") ?? "", intParam(url, "depth", 1)));
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/file");
      if (method === "GET" && params) {
        const filePath = requireString(url.searchParams.get("path"), "path");
        json(res, 200, await app.projects.readText(params.key!, filePath, intParam(url, "offset", 0)));
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/media");
      if (method === "GET" && params) {
        const media = await app.projects.readMedia(params.key!, requireString(url.searchParams.get("path"), "path"));
        bytes(res, media.mime, media.data);
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/review");
      if (method === "GET" && params) {
        json(res, 200, await app.reviewDocuments.read((await app.projects.get(params.key!)).key));
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/review/progress");
      if (method === "GET" && params) {
        json(res, 200, app.review.progress((await app.projects.get(params.key!)).key));
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/review/cancel");
      if (method === "POST" && params) {
        json(res, 200, { cancelled: app.review.cancel((await app.projects.get(params.key!)).key) });
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/review/dismissed");
      if (method === "POST" && params) {
        const project = await app.projects.get(params.key!);
        const body = await readJson<{ id?: unknown }>(req);
        json(res, 200, await app.reviewDocuments.dismiss(project.key, requireString(body.id, "id")));
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/review/dismissed/:id");
      if (method === "DELETE" && params) {
        const project = await app.projects.get(params.key!);
        json(res, 200, await app.reviewDocuments.restore(project.key, params.id!));
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/chat");
      if (method === "GET" && params) {
        json(res, 200, { lines: await app.projectChat.read((await app.projects.get(params.key!)).key) });
        return;
      }
      if (method === "POST" && params) {
        const project = await app.projects.get(params.key!);
        const body = await readJson<{ lines?: unknown }>(req);
        json(res, 200, { saved: await app.projectChat.write(project.key, body.lines) });
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/pdf-annotations");
      if (method === "GET" && params) {
        const project = await app.projects.get(params.key!);
        json(res, 200, project.paperPath === null ? [] : await app.pdfAnnotations.list(project.key, project.paperPath));
        return;
      }
      if (method === "POST" && params) {
        const project = await app.projects.get(params.key!);
        const body = await readJson<{ quote?: unknown; page?: unknown; note?: unknown; color?: unknown; findingId?: unknown }>(req);
        const page = body.page === undefined ? undefined : Math.trunc(Number(body.page));
        const note = typeof body.note === "string" ? body.note : undefined;
        if (body.findingId !== undefined && typeof body.findingId !== "string") throw new UserError("findingId must be a string");
        const findingId = body.findingId;
        if (typeof body.quote === "string" && body.quote.trim()) {
          const color = typeof body.color === "string" && (PDF_ANNOTATION_COLORS as readonly string[]).includes(body.color)
            ? body.color as PdfAnnotationColor
            : undefined;
          const { annotation } = await app.pdfAnnotations.highlight({
            projectKey: project.key,
            path: requirePaperPath(project),
            quote: body.quote,
            ...(page ? { page } : {}),
            ...(color ? { color } : {}),
            ...(note ? { note } : {}),
            ...(findingId ? { findingId } : {}),
          });
          json(res, 201, annotation);
          return;
        }
        if (!page || page < 1) throw new UserError("pass quote, or page and note");
        json(res, 201, await app.pdfAnnotations.addNote({
          projectKey: project.key,
          path: requirePaperPath(project),
          page,
          text: requireString(note, "note"),
          ...(findingId ? { findingId } : {}),
        }));
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/pdf-annotations/:number");
      const number = params ? Math.trunc(Number(params.number)) : NaN;
      if (params && Number.isFinite(number) && (method === "PATCH" || method === "DELETE")) {
        const project = await app.projects.get(params.key!);
        if (method === "DELETE") {
          json(res, 200, await app.pdfAnnotations.remove(project.key, requirePaperPath(project), number));
          return;
        }
        const body = await readJson<{ note?: unknown }>(req);
        if (body.note !== null && typeof body.note !== "string") throw new UserError("note must be a string or null");
        json(res, 200, await app.pdfAnnotations.setNote(project.key, requirePaperPath(project), number, body.note));
        return;
      }
    }

    {
      const params = match(path, "/projects/:key/pdf-annotations/export");
      if (method === "GET" && params) {
        const format = url.searchParams.get("format");
        if (!isPdfAnnotationExportFormat(format)) {
          throw new UserError(`format must be ${PDF_ANNOTATION_EXPORT_FORMATS.join(" or ")}`);
        }
        const project = await app.projects.get(params.key!);
        const exported = await app.pdfAnnotations.export(project.key, requirePaperPath(project), format);
        bytes(res, exported.contentType, exported.data, exported.filename);
        return;
      }
    }

    if (method === "POST" && path === "/import-uploads") {
      const body = await readJson<{ title?: unknown; codeUrl?: unknown }>(req);
      json(res, 201, await app.importUpload.init({
        title: requireString(body.title, "title"),
        ...(body.codeUrl === undefined ? {} : { codeUrl: requireString(body.codeUrl, "codeUrl") }),
      }));
      return;
    }

    {
      const params = match(path, "/import-uploads/:id/chunks/:index");
      if (method === "POST" && params) {
        const data = await readRaw(req, IMPORT_UPLOAD_MAX_CHUNK_BYTES);
        json(res, 200, await app.importUpload.appendChunk(params.id!, Number(params.index), data));
        return;
      }
    }

    {
      const params = match(path, "/import-uploads/:id/finalize");
      if (method === "POST" && params) {
        const body = await readJson<{ totalChunks: number; totalBytes: number }>(req);
        json(res, 200, await app.importUpload.finalize(params.id!, body));
        return;
      }
    }

    {
      const params = match(path, "/import-uploads/:id");
      if (method === "GET" && params) {
        json(res, 200, app.importUpload.status(params.id!));
        return;
      }
    }

    if (method === "POST" && path === "/realtime/token") {
      try {
        json(res, 200, await mintRealtimeToken());
      } catch (error) {
        if (!(error instanceof RealtimeTokenError)) throw error;
        json(res, error.status, {
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
        });
      }
      return;
    }

    if (method === "POST" && path === "/realtime/tool") {
      const body = await readJson<{ name: string; args: Record<string, unknown>; session: string }>(req);
      // Navigation rides the response: the calling browser is the only nav
      // consumer, and the SSE stream can drop an event it would never replay.
      const navEvents: NavEvent[] = [];
      const tools = createToolRegistry({ app, onNav: (event) => navEvents.push(event) });
      const result = await dispatchVoiceTool(tools, body.name, body.args, body.session);
      json(
        res,
        200,
        navEvents.length > 0 && typeof result === "object" && result !== null
          ? { ...result, navEvents }
          : result,
      );
      return;
    }

    json(res, 404, { error: `no route ${method} ${path}` });
  }

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const suppliedRequestId = req.headers["x-gali-request-id"];
    const requestId = typeof suppliedRequestId === "string"
      && /^[A-Za-z0-9_-]{8,64}$/.test(suppliedRequestId)
      ? suppliedRequestId
      : crypto.randomUUID();
    res.setHeader("x-gali-request-id", requestId);

    if (method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    // Before anything else, including activity tracking: an unauthenticated
    // caller must not even be able to hold the sandbox awake.
    if (!allowed(req, url)) {
      json(res, 401, { error: "unauthorized" });
      return;
    }

    if (!NON_ACTIVITY_PATHS.has(url.pathname)) {
      activity.requestStarted();
      res.on("close", () => activity.requestFinished());
    }

    route(req, res, method, url).catch((error: unknown) => {
      if (error instanceof UserError) {
        if (!res.headersSent) json(res, 400, { error: error.message });
        return;
      }
      logSandboxEvent({
        eventName: "sandbox.http.failed",
        level: "error",
        requestId,
        status: 500,
        ...operationalErrorFields(error),
      });
      if (!res.headersSent) json(res, 500, { error: "internal server error", requestId });
      else res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      resolve({
        port: opts.port,
        publishReviewer: (event) => publishReplayable("reviewer", event),
        publishProject: (event) => publishReplayable("project", event),
        publishNav: (event) => broadcast("nav", event),
        publishProgress: (event) => broadcast("progress", event),
        close: () =>
          new Promise((resClose, rejClose) => {
            for (const client of sse) client.end();
            sse.clear();
            server.close((err) => (err ? rejClose(err) : resClose()));
          }),
      });
    });
  });
}
