import { afterEach, expect, test } from "vitest";
import {
  mintModelGatewayToken,
  mintSandboxCapabilityToken,
  verifySandboxCapabilityToken,
  verifyModelGatewayToken,
} from "./model-gateway-token.js";

afterEach(() => {
  delete process.env.GALI_MODEL_GATEWAY_SECRET;
});

test("mints a sandbox-bound expiring token", () => {
  process.env.GALI_MODEL_GATEWAY_SECRET = "test-signing-secret";
  const now = Date.UTC(2026, 8, 17);
  const claims = verifyModelGatewayToken(
    mintModelGatewayToken(42, "sandbox-42", now),
    now,
  );
  expect(claims).toMatchObject({
    v: 1,
    aud: "model",
    userId: 42,
    sandboxId: "sandbox-42",
  });
  expect(claims.exp).toBeGreaterThan(Math.floor(now / 1000));
});

test("a capability token is accepted only for its exact audience", () => {
  process.env.GALI_MODEL_GATEWAY_SECRET = "test-signing-secret";
  const token = mintSandboxCapabilityToken("sleep", 42, "sandbox-42");
  expect(verifySandboxCapabilityToken(token, "sleep").aud).toBe("sleep");
  expect(() => verifySandboxCapabilityToken(token, "model")).toThrow(/invalid claims/);
  expect(() => verifyModelGatewayToken(token)).toThrow(/invalid claims/);
});

test("rejects modified and expired tokens", () => {
  process.env.GALI_MODEL_GATEWAY_SECRET = "test-signing-secret";
  const now = Date.UTC(2026, 8, 17);
  const token = mintModelGatewayToken(42, "sandbox-42", now);
  const [payload, signature] = token.split(".");
  const modified = `${payload}.${signature!.slice(0, -1)}x`;
  expect(() => verifyModelGatewayToken(modified, now)).toThrow(/invalid/);
  expect(() => verifyModelGatewayToken(token, now + 26 * 60 * 60 * 1000)).toThrow(
    /expired/,
  );
});
