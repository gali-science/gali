import type { VercelRequest, VercelResponse } from "@vercel/node";
import { beforeEach, expect, test, vi } from "vitest";

const verifyTelemetryToken = vi.fn();
const getUserById = vi.fn();
const logOperationalEvent = vi.fn();

vi.mock("./telemetry-token.js", () => ({
  verifyTelemetryToken: (...args: unknown[]) => verifyTelemetryToken(...args),
}));
vi.mock("./users.js", () => ({
  getUserById: (...args: unknown[]) => getUserById(...args),
}));
vi.mock("./operational-log.js", () => ({
  requestId: () => "request-12345678",
  errorFields: (error: unknown) => ({
    errorCode: "Error",
    errorMessage: String(error),
  }),
  logOperationalEvent: (...args: unknown[]) => logOperationalEvent(...args),
}));

function request(events: unknown[]): VercelRequest {
  return {
    method: "POST",
    headers: { authorization: "Bearer telemetry-token" },
    body: { events },
    query: {},
  } as unknown as VercelRequest;
}

function response(): VercelResponse & { statusCode: number; body?: unknown } {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    setHeader() {
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
  };
  return res as unknown as ReturnType<typeof response>;
}

const sandboxEvent = {
  schemaVersion: 1,
  eventId: "event-12345678",
  eventName: "review.failed",
  occurredAt: new Date().toISOString(),
  level: "error",
  source: "sandbox",
  userId: 999,
  sandboxId: "forged-box",
  runId: "run-7",
  errorCode: "ProviderError",
  errorMessage: "provider failed",
};

beforeEach(() => {
  vi.clearAllMocks();
  verifyTelemetryToken.mockReturnValue({ userId: 7, sandboxId: "box-7" });
  getUserById.mockResolvedValue({ id: 7, sandboxId: "box-7" });
});

test("derives identity from the token instead of the event body", async () => {
  const { default: handler } = await import("../telemetry.js");
  const res = response();

  await handler(request([sandboxEvent]), res);

  expect(res.statusCode).toBe(202);
  expect(logOperationalEvent).toHaveBeenCalledWith(expect.objectContaining({
    userId: 7,
    sandboxId: "box-7",
    runId: "run-7",
  }));
});

test("rejects a token for a stale sandbox", async () => {
  getUserById.mockResolvedValue({ id: 7, sandboxId: "box-new" });
  const { default: handler } = await import("../telemetry.js");
  const res = response();

  await handler(request([sandboxEvent]), res);

  expect(res.statusCode).toBe(401);
  expect(logOperationalEvent).not.toHaveBeenCalled();
});
