import { afterEach, expect, test } from "vitest";
import {
  mintTelemetryToken,
  verifyTelemetryToken,
} from "./telemetry-token.js";

afterEach(() => {
  delete process.env.GALI_TELEMETRY_SECRET;
});

test("mints a telemetry-only token bound to one sandbox", () => {
  process.env.GALI_TELEMETRY_SECRET = "telemetry-signing-secret";
  const now = Date.UTC(2026, 8, 29);
  const token = mintTelemetryToken(7, "box-7", now);
  expect(verifyTelemetryToken(token, now)).toMatchObject({
    aud: "telemetry",
    userId: 7,
    sandboxId: "box-7",
  });
});

test("rejects tampering and expiry", () => {
  process.env.GALI_TELEMETRY_SECRET = "telemetry-signing-secret";
  const now = Date.UTC(2026, 8, 29);
  const token = mintTelemetryToken(7, "box-7", now);
  expect(() => verifyTelemetryToken(`${token}x`, now)).toThrow(/invalid/);
  expect(() => verifyTelemetryToken(token, now + 26 * 60 * 60 * 1_000)).toThrow(/expired/);
});
