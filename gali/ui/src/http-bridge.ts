import type {
  NavEvent,
  ProjectEvent,
  ReviewProgressEvent,
  ReviewerEvent,
} from "../../shared/domain/contracts";
import { reportClientEvent } from "./account";
import {
  authenticatedFetch,
  AuthRequiredError,
} from "./auth-fetch";
import {
  ENSURE_STREAM_TYPE,
  sandboxErrorBody,
  type EnsureStreamLine,
  type WakeProgressPhase,
} from "../../shared/sandbox-health";
import { bootTrace } from "./app/boot-trace";
import {
  WorkspaceUnavailableError,
  type WorkspaceHealthMonitor,
} from "./workspace-health";

export { AuthRequiredError } from "./auth-fetch";

export const GALI_HTTP_BASE = "/api/gali";

// The server sends a heartbeat every 15 s; this long without a byte means a dead connection.
const STREAM_SILENCE_MS = 45_000;

type Seq = { seq: number };
export type SeqReviewerEvent = ReviewerEvent & Seq;
export type SeqProjectEvent = ProjectEvent & Seq;

type EventsRecentDto = {
  latest: number;
  reviewer: SeqReviewerEvent[];
  projects: SeqProjectEvent[];
};

export type GaliClient = {
  json<T>(method: string, path: string, body?: unknown): Promise<T>;
  send<T>(method: string, path: string, body: BodyInit, type: string): Promise<T>;
  media(path: string): Promise<{ data: Uint8Array; mime: string }>;
  runTool(name: string, args: Record<string, unknown>, session: string): Promise<unknown>;
  onReviewer(cb: (event: SeqReviewerEvent) => void): () => void;
  onProject(cb: (event: SeqProjectEvent) => void): () => void;
  onNav(cb: (event: NavEvent) => void): () => void;
  onProgress(cb: (event: ReviewProgressEvent) => void): () => void;
  /** The workspace process restarted: whatever was in flight on it is gone. */
  onRestart(cb: () => void): () => void;
};

function readWithin<T>(
  reader: ReadableStreamDefaultReader<T>,
  ms: number,
): Promise<ReadableStreamReadResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silence = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void reader.cancel().catch(() => {});
      reject(new Error("event stream went silent"));
    }, ms);
  });
  return Promise.race([reader.read(), silence]).finally(() => clearTimeout(timer));
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// What a response says about the workspace, as opposed to about the request:
// a 4xx or a Gali 500 still means the sandbox answered.
function noteResponse(health: WorkspaceHealthMonitor, status: number, body: unknown): void {
  const typed = sandboxErrorBody(body);
  if (typed?.error === "sandbox_unavailable") health.unavailable(typed.failure);
  else if (typed || status === 502 || status === 503 || status === 504) health.lost();
  else health.reached();
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createGaliClient(config: { baseUrl: string; health: WorkspaceHealthMonitor }): GaliClient {
  const base = config.baseUrl.replace(/\/$/, "");
  const { health } = config;

  async function reach(url: string, init: RequestInit): Promise<Response> {
    try {
      return await authenticatedFetch(url, init);
    } catch (error) {
      if (!(error instanceof AuthRequiredError) && !isAbort(error)) health.lost();
      throw error;
    }
  }

  async function failure(method: string, path: string, res: Response, text: string): Promise<never> {
    const data = text ? parseBody(text) : null;
    noteResponse(health, res.status, data);
    const typed = sandboxErrorBody(data);
    if (typed?.error === "sandbox_unavailable") throw new WorkspaceUnavailableError(typed.failure);
    const message = data && typeof data === "object" && "error" in data
      ? String((data as { error: unknown }).error)
      : text;
    throw new Error(message || `${method} ${path} -> ${res.status}`);
  }

  async function send<T>(method: string, path: string, body?: BodyInit, type?: string): Promise<T> {
    const res = await reach(`${base}${path}`, {
      method,
      ...(type ? { headers: { "Content-Type": type } } : {}),
      ...(body === undefined ? {} : { body }),
    });
    const text = await res.text();
    if (!res.ok) return failure(method, path, res, text);
    health.reached();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${method} ${path} -> ${res.status}: non-JSON response (${text.slice(0, 80).replaceAll("\n", " ")})`);
    }
  }

  function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    return body === undefined
      ? send<T>(method, path)
      : send<T>(method, path, JSON.stringify(body), "application/json");
  }

  async function media(path: string): Promise<{ data: Uint8Array; mime: string }> {
    const res = await reach(`${base}${path}`, { method: "GET" });
    if (!res.ok) return failure("GET", path, res, await res.text());
    health.reached();
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mime: res.headers.get("Content-Type") ?? "application/octet-stream",
    };
  }

  type Fan = (payload: unknown) => void;
  const fans: Record<"reviewer" | "project" | "nav" | "progress" | "restart", Set<Fan>> = {
    reviewer: new Set(),
    project: new Set(),
    nav: new Set(),
    progress: new Set(),
    restart: new Set(),
  };
  let streamAbort: AbortController | null = null;
  let streamUsers = 0;

  // Reviewer and project events share one server-side seq; the cursor lets a
  // reconnect replay what was published while the stream was down, once.
  let replayCursor: number | null = null;

  function dispatchSeq(kind: "reviewer" | "project", payload: Seq) {
    if (replayCursor !== null && payload.seq <= replayCursor) return;
    replayCursor = payload.seq;
    for (const fan of fans[kind]) fan(payload);
  }

  // When the stream last carried a byte; a gap report says how long it was down.
  let lastStreamByteAt: number | null = null;

  function reportGap(phase: string, status?: string | number) {
    reportClientEvent({
      eventName: "client.stream.gap",
      phase,
      ...(lastStreamByteAt === null ? {} : { durationMs: Date.now() - lastStreamByteAt }),
      ...(status === undefined ? {} : { status }),
    });
  }

  async function replayMissed() {
    try {
      const recent = await json<EventsRecentDto>(
        "GET",
        `/events/recent${replayCursor === null ? "" : `?since=${replayCursor}`}`,
      );
      if (replayCursor === null || replayCursor > recent.latest) {
        const restarted = replayCursor !== null;
        if (restarted) reportGap("backend-restarted", `cursor ${replayCursor} > latest ${recent.latest}`);
        replayCursor = recent.latest;
        if (restarted) for (const fan of fans.restart) fan(null);
        return;
      }
      const missed = [
        ...recent.reviewer.map((event) => ({ kind: "reviewer" as const, event })),
        ...recent.projects.map((event) => ({ kind: "project" as const, event })),
      ].sort((left, right) => left.event.seq - right.event.seq);
      const firstSeq = missed[0]?.event.seq ?? recent.latest + 1;
      if (firstSeq > replayCursor + 1) reportGap("replay-truncated", firstSeq - replayCursor - 1);
      for (const { kind, event } of missed) dispatchSeq(kind, event);
    } catch (error) {
      // Catch-up is best effort; the live stream keeps flowing regardless.
      reportGap("replay-failed", (error instanceof Error ? error.message : String(error)).slice(0, 120));
    }
  }

  // Reconnecting from a hidden tab would also resume a paused sandbox (the proxy's
  // resolve step wakes it), so hold retries until the page is visible again.
  function waitForVisible(): Promise<void> {
    if (document.visibilityState === "visible") return Promise.resolve();
    return new Promise((resolve) => {
      const onChange = () => {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", onChange);
        resolve();
      };
      document.addEventListener("visibilitychange", onChange);
    });
  }

  // Ends early once anything reaches the workspace again, so the stream does
  // not sit out a long backoff after recovery.
  function backoff(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, ms);
      const off = health.subscribe(() => {
        if (health.current().state === "ok") done();
      });
    });
  }

  // The BFF proxy caps each /events response and the sandbox can be paused
  // underneath us, so drops are routine: reconnect for as long as anyone listens.
  async function ensureEventStream() {
    if (streamAbort) return;
    const abort = new AbortController();
    streamAbort = abort;
    let retryMs = 1_000;
    while (streamUsers > 0 && streamAbort === abort) {
      let connected = false;
      try {
        await waitForVisible();
        if (streamUsers === 0 || streamAbort !== abort) break;
        const res = await reach(`${base}/events`, { signal: abort.signal });
        if (!res.ok || !res.body) {
          noteResponse(health, res.status, parseBody(await res.text()));
          throw new Error(`SSE /events -> ${res.status}`);
        }
        health.reached();
        connected = true;
        // Live frames buffer in the body meanwhile; the seq cursor dedupes overlap.
        await replayMissed();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await readWithin(reader, STREAM_SILENCE_MS);
          if (done) break;
          lastStreamByteAt = Date.now();
          health.reached();
          buffer += decoder.decode(value, { stream: true });
          for (;;) {
            const sep = buffer.indexOf("\n\n");
            if (sep < 0) break;
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let eventName = "message";
            const dataLines: string[] = [];
            for (const line of frame.split("\n")) {
              if (line.startsWith("event:")) eventName = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (eventName === "reviewer" || eventName === "project") {
              dispatchSeq(eventName, JSON.parse(dataLines.join("\n")) as Seq);
            } else if (eventName === "nav" || eventName === "progress") {
              const payload: unknown = JSON.parse(dataLines.join("\n"));
              for (const fan of fans[eventName]) fan(payload);
            }
          }
        }
      } catch (error) {
        if (isAbort(error)) break;
        if (connected) health.lost();
        // No token yet means Clerk is between tokens; a real sign-out unmounts
        // every listener, which aborts this loop.
        if (!(error instanceof AuthRequiredError)) console.error("[gali] event stream ended", error);
      }
      if (streamUsers === 0 || streamAbort !== abort) break;
      const waitMs = connected ? 250 : retryMs;
      retryMs = connected ? 1_000 : Math.min(retryMs * 2, 15_000);
      await backoff(waitMs);
    }
    if (streamAbort === abort) streamAbort = null;
  }

  function subscribe(kind: "reviewer" | "project" | "nav" | "progress" | "restart", cb: Fan): () => void {
    fans[kind].add(cb);
    streamUsers += 1;
    void ensureEventStream();
    return () => {
      fans[kind].delete(cb);
      streamUsers -= 1;
      if (streamUsers === 0 && streamAbort) {
        streamAbort.abort();
        streamAbort = null;
      }
    };
  }

  return {
    json,
    send: (method, path, body, type) => send(method, path, body, type),
    media,
    async runTool(name, args, session) {
      const result = await json<unknown>("POST", "/realtime/tool", { name, args, session });
      if (
        result === null || typeof result !== "object"
        || !Array.isArray((result as { navEvents?: unknown }).navEvents)
      ) {
        return result;
      }
      // The tool's navigation rides its response (the stream can drop events);
      // apply it before the model sees the result so "opened" is already true.
      const { navEvents, ...rest } = result as { navEvents: NavEvent[] } & Record<string, unknown>;
      for (const event of navEvents) {
        for (const fan of fans.nav) fan(event);
      }
      return rest;
    },
    onReviewer: (cb) => subscribe("reviewer", cb as Fan),
    onProject: (cb) => subscribe("project", cb as Fan),
    onNav: (cb) => subscribe("nav", cb as Fan),
    onProgress: (cb) => subscribe("progress", cb as Fan),
    onRestart: (cb) => subscribe("restart", cb),
  };
}

export function httpBridgeEnabled(): boolean {
  return (
    Boolean(import.meta.env.VITE_GALI_HTTP_URL) ||
    import.meta.env.VITE_GALI_HTTP === "1"
  );
}

const WAKING_RETRY_MS = 5_000;

// Another request may hold the wake for longer than one ensure waits; that is
// progress, not failure, so boot keeps asking until it gets a real answer.
export async function ensureSandboxReady(
  health: WorkspaceHealthMonitor,
  onProgress: (phase: WakeProgressPhase) => void = () => {},
): Promise<{ status: string }> {
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    const result = await ensureSandboxOnce(health, onProgress);
    if (result !== "waking") {
      reportClientEvent({
        eventName: "client.boot.completed",
        phase: "ensure",
        durationMs: Date.now() - startedAt,
        status: attempt,
      });
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, WAKING_RETRY_MS));
  }
}

async function ensureSandboxOnce(
  health: WorkspaceHealthMonitor,
  onProgress: (phase: WakeProgressPhase) => void,
): Promise<{ status: string } | "waking"> {
  bootTrace("ensure: asking");
  const res = await authenticatedFetch("/api/sandbox/ensure", {
    method: "POST",
    headers: { Accept: `${ENSURE_STREAM_TYPE}, application/json` },
  });
  bootTrace(`ensure: ${res.status}`);
  if (res.status === 401) throw new AuthRequiredError("authentication required");
  if (res.ok && res.body && res.headers.get("Content-Type")?.startsWith(ENSURE_STREAM_TYPE)) {
    return readEnsureStream(health, res.body, onProgress);
  }
  const text = await res.text();
  let data: { status?: string; error?: string } = {};
  if (text) {
    try {
      data = JSON.parse(text) as { status?: string; error?: string };
    } catch {
      throw new Error(`sandbox ensure -> ${res.status}: ${text.slice(0, 120)}`);
    }
  }
  if (!res.ok) return ensureFailed(health, res.status, data);
  health.reached();
  return { status: data.status ?? "ready" };
}

async function readEnsureStream(
  health: WorkspaceHealthMonitor,
  body: ReadableStream<Uint8Array>,
  onProgress: (phase: WakeProgressPhase) => void,
): Promise<{ status: string } | "waking"> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) throw new Error("sandbox ensure stream ended without an answer");
    buffer += decoder.decode(value, { stream: true });
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = JSON.parse(buffer.slice(0, newline)) as EnsureStreamLine;
      buffer = buffer.slice(newline + 1);
      if (line.type === "progress") {
        bootTrace(`ensure: ${line.phase}`);
        onProgress(line.phase);
      } else if (line.type === "ready") {
        void reader.cancel().catch(() => {});
        health.reached();
        return { status: "ready" };
      } else {
        void reader.cancel().catch(() => {});
        return ensureFailed(health, line.status, line.body);
      }
    }
  }
}

function ensureFailed(health: WorkspaceHealthMonitor, status: number, data: unknown): "waking" {
  const typed = sandboxErrorBody(data);
  if (typed?.error === "sandbox_unavailable") {
    health.unavailable(typed.failure);
    throw new WorkspaceUnavailableError(typed.failure);
  }
  if (typed?.error === "sandbox_waking") return "waking";
  const message = data && typeof data === "object" && "error" in data
    ? String((data as { error: unknown }).error)
    : null;
  throw new Error(message ?? `sandbox ensure -> ${status}`);
}
