import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sandboxHttpSecret } from "./_lib/sandbox-http-auth.js";

vi.mock("./_lib/auth.js", () => ({
  getSession: vi.fn(() => ({ userId: 7 })),
}));

vi.mock("./_lib/sandbox-resolve.js", () => ({
  routeSandbox: vi.fn(),
  resolveSandbox: vi.fn(),
  forgetCached: vi.fn(),
}));

const ACTIVE = { sandboxId: "box-active", host: "https://active.example" };
const RECOVERED = { sandboxId: "box-recovered", host: "https://recovered.example" };

function request(method = "GET"): VercelRequest {
  return {
    method,
    url: "/api/gali/rpc?galiPath=rpc",
    query: { galiPath: "rpc" },
    headers: {
      "x-gali-request-id": "request-12345678",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    async *[Symbol.asyncIterator]() {
      if (method === "POST") yield Buffer.from('{"ok":true}');
    },
  } as unknown as VercelRequest;
}

function response(): VercelResponse & {
  statusCode: number;
  output: Buffer[];
  jsonBody?: unknown;
  headers: Record<string, string>;
} {
  const res = {
    statusCode: 200,
    output: [] as Buffer[],
    jsonBody: undefined as unknown,
    headers: {} as Record<string, string>,
    headersSent: false,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    write(chunk: Buffer) {
      this.headersSent = true;
      this.output.push(chunk);
      return true;
    },
    end() {
      this.headersSent = true;
      return this;
    },
    json(body: unknown) {
      this.headersSent = true;
      this.jsonBody = body;
      return this;
    },
  };
  return res as unknown as ReturnType<typeof response>;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.GALI_SANDBOX_HTTP_MASTER_KEY = "sandbox-http-master";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("active requests route from the trusted database host without control-plane checks", async () => {
  const { routeSandbox, resolveSandbox } = await import("./_lib/sandbox-resolve.js");
  vi.mocked(routeSandbox).mockResolvedValue(ACTIVE);
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const { default: handler } = await import("./gali-proxy.js");
  const res = response();
  await handler(request(), res);

  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0]?.[0]).toBe("https://active.example/rpc");
  expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers)
    .get("x-gali-request-id")).toBe("request-12345678");
  expect(new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit).headers)
    .get("x-gali-secret")).toBe(sandboxHttpSecret(7, "box-active"));
  expect(resolveSandbox).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(200);
});

test("a safe request recovers and retries once after a gateway failure", async () => {
  const { routeSandbox, resolveSandbox, forgetCached } =
    await import("./_lib/sandbox-resolve.js");
  vi.mocked(routeSandbox).mockResolvedValue(ACTIVE);
  vi.mocked(resolveSandbox).mockResolvedValue(RECOVERED);
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response("dead", { status: 502 }))
    .mockResolvedValueOnce(new Response("healthy", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const { default: handler } = await import("./gali-proxy.js");
  const res = response();
  await handler(request(), res);

  expect(forgetCached).toHaveBeenCalledWith(7);
  expect(resolveSandbox).toHaveBeenCalledWith(7);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1]?.[0]).toBe("https://recovered.example/rpc");
  expect(new Headers((fetchMock.mock.calls[1]?.[1] as RequestInit).headers)
    .get("x-gali-secret")).toBe(sandboxHttpSecret(7, "box-recovered"));
  expect(res.statusCode).toBe(200);
});

test("a mutation is recovered but never replayed after an ambiguous transport failure", async () => {
  const { routeSandbox, resolveSandbox } = await import("./_lib/sandbox-resolve.js");
  vi.mocked(routeSandbox).mockResolvedValue(ACTIVE);
  vi.mocked(resolveSandbox).mockResolvedValue(RECOVERED);
  const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const { default: handler } = await import("./gali-proxy.js");
  const res = response();
  await handler(request("POST"), res);

  expect(resolveSandbox).toHaveBeenCalledWith(7);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(res.statusCode).toBe(502);
  expect(res.jsonBody).toMatchObject({
    error: "sandbox proxy failed",
    requestId: "request-12345678",
  });
});

test("a sandbox that cannot start is a typed 503 carrying the provider's reason", async () => {
  const { routeSandbox } = await import("./_lib/sandbox-resolve.js");
  const { SandboxUnavailableError } = await import("./_lib/sandbox-provider/types.js");
  const failure = { kind: "out_of_memory", provider: "vercel", detail: "sandbox b is terminated (oom_killed)" } as const;
  vi.mocked(routeSandbox).mockRejectedValue(new SandboxUnavailableError(failure));
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const { default: handler } = await import("./gali-proxy.js");
  const res = response();
  await handler(request(), res);

  expect(res.statusCode).toBe(503);
  expect(res.jsonBody).toEqual({ error: "sandbox_unavailable", failure, requestId: "request-12345678" });
});

test("a sandbox still coming up is a 503 that says when to retry", async () => {
  const { routeSandbox } = await import("./_lib/sandbox-resolve.js");
  const { SandboxBusyError } = await import("./_lib/sandbox-provider/types.js");
  vi.mocked(routeSandbox).mockRejectedValue(new SandboxBusyError("recovering"));
  vi.spyOn(console, "error").mockImplementation(() => undefined);

  const { default: handler } = await import("./gali-proxy.js");
  const res = response();
  const setHeader = vi.spyOn(res, "setHeader");
  await handler(request(), res);

  expect(res.statusCode).toBe(503);
  expect(setHeader).toHaveBeenCalledWith("retry-after", "5");
  expect(res.jsonBody).toEqual({ error: "sandbox_waking", requestId: "request-12345678" });
});

test("the event stream closes before Vercel's hard timeout", async () => {
  vi.useFakeTimers();
  const { routeSandbox } = await import("./_lib/sandbox-resolve.js");
  vi.mocked(routeSandbox).mockResolvedValue(ACTIVE);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("event: ready\n\n"));
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })));
  const req = request();
  req.url = "/api/gali/events?galiPath=events";
  req.query = { galiPath: "events" };
  const { default: handler, EVENT_STREAM_MAX_MS } = await import("./gali-proxy.js");
  const res = response();

  const pending = handler(req, res);
  await vi.advanceTimersByTimeAsync(EVENT_STREAM_MAX_MS);
  await pending;

  expect(res.statusCode).toBe(200);
  expect(res.headersSent).toBe(true);
});

test("sandbox content opened directly cannot run scripts on the app origin", async () => {
  const { routeSandbox } = await import("./_lib/sandbox-resolve.js");
  vi.mocked(routeSandbox).mockResolvedValue(ACTIVE);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<svg onload=alert(1)/>", {
    status: 200,
    headers: { "content-type": "image/svg+xml" },
  })));

  const { default: handler } = await import("./gali-proxy.js");
  const res = response();
  await handler(request(), res);

  expect(res.headers["content-type"]).toBe("image/svg+xml");
  expect(res.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
});
