import { afterEach, expect, test, vi } from "vitest";
import {
  configureOperationalLogger,
  logSandboxEvent,
} from "../src/observability/operational-logger.js";

afterEach(() => {
  configureOperationalLogger({});
  vi.restoreAllMocks();
});

test("stays local when telemetry is disabled in a sandbox", () => {
  configureOperationalLogger({ sandboxId: "box-7" });
  const info = vi.spyOn(console, "info").mockImplementation(() => {});

  expect(() => logSandboxEvent({
    eventName: "sandbox.process.started",
    level: "info",
  })).not.toThrow();
  expect(info).toHaveBeenCalledOnce();
});

test("forwards one sanitized event with the telemetry token", async () => {
  const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 202 }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  configureOperationalLogger({
    url: "https://gali.example/api/telemetry",
    token: "telemetry-token",
    sandboxId: "box-7",
    version: "abc123",
    fetchImpl,
  });

  logSandboxEvent({
    eventName: "review.failed",
    level: "error",
    runId: "run-7",
    errorCode: "ProviderError",
    errorMessage: "failed\nwithout secrets",
  });

  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
  const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
  expect(new Headers(init.headers).get("authorization")).toBe("Bearer telemetry-token");
  const body = JSON.parse(String(init.body)) as { events: Array<Record<string, unknown>> };
  expect(body.events[0]).toMatchObject({
    eventName: "review.failed",
    source: "sandbox",
    version: "abc123",
    runId: "run-7",
    errorMessage: "failed without secrets",
  });
});

test("delivery failures remain best-effort and do not throw", async () => {
  const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  configureOperationalLogger({
    url: "https://gali.example/api/telemetry",
    token: "telemetry-token",
    sandboxId: "box-7",
    fetchImpl,
  });

  expect(() => logSandboxEvent({
    eventName: "review.failed",
    level: "error",
    sessionId: 3,
  })).not.toThrow();

  await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
});
