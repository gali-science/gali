import { expect, test } from "vitest";
import {
  parseOperationalEvent,
  sanitizeErrorMessage,
} from "../shared/observability/operational-event.js";

const event = {
  schemaVersion: 1,
  eventId: "event-12345678",
  eventName: "review.failed",
  occurredAt: "2026-09-29T12:00:00.000Z",
  level: "error",
  source: "sandbox",
  sandboxId: "box-7",
  runId: "run-7",
  errorCode: "ProviderError",
  errorMessage: "provider failed",
};

test("accepts the allowlisted operational event shape", () => {
  expect(parseOperationalEvent(event)).toEqual(event);
});

test("rejects unknown fields and event names", () => {
  expect(() => parseOperationalEvent({ ...event, prompt: "secret" })).toThrow(
    /field 'prompt' is not allowed/,
  );
  expect(() => parseOperationalEvent({ ...event, eventName: "prompt.logged" })).toThrow(
    /name is not allowed/,
  );
});

test("sanitizes control characters and bounds error messages", () => {
  expect(sanitizeErrorMessage("bad\n\tmessage\u0000")).toBe("bad message");
  expect(sanitizeErrorMessage("x".repeat(1_000))).toHaveLength(500);
});

test("redacts common credential forms from error messages", () => {
  const message = sanitizeErrorMessage(
    "Bearer token-value api_key=sk-abcdefghijklmnop https://x.test?a=1&token=secret-value",
  );
  expect(message).not.toContain("token-value");
  expect(message).not.toContain("sk-abcdefghijklmnop");
  expect(message).not.toContain("secret-value");
  expect(message).not.toContain("a=1");
});
