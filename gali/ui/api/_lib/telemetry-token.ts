import crypto from "node:crypto";
import { SANDBOX_TOKEN_TTL_SECONDS } from "./model-gateway-token.js";

const TOKEN_VERSION = 1;
const AUDIENCE = "telemetry";

export type TelemetryTokenClaims = {
  v: typeof TOKEN_VERSION;
  aud: typeof AUDIENCE;
  userId: number;
  sandboxId: string;
  exp: number;
};

function signingSecret(): string {
  const value = process.env.GALI_TELEMETRY_SECRET;
  if (!value?.trim()) throw new Error("GALI_TELEMETRY_SECRET is not set");
  return value.trim();
}

function signature(payload: string): Buffer {
  return crypto.createHmac("sha256", signingSecret()).update(payload).digest();
}

export function mintTelemetryToken(
  userId: number,
  sandboxId: string,
  nowMs = Date.now(),
): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("userId is invalid");
  if (!sandboxId.trim()) throw new Error("sandboxId is required");
  const claims: TelemetryTokenClaims = {
    v: TOKEN_VERSION,
    aud: AUDIENCE,
    userId,
    sandboxId,
    exp: Math.floor(nowMs / 1000) + SANDBOX_TOKEN_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifyTelemetryToken(
  token: string,
  nowMs = Date.now(),
): TelemetryTokenClaims {
  if (token.length > 4096) throw new Error("telemetry token is invalid");
  const [payload, encodedSignature, ...rest] = token.split(".");
  if (!payload || !encodedSignature || rest.length > 0) {
    throw new Error("telemetry token is invalid");
  }
  const expected = signature(payload);
  const provided = Buffer.from(encodedSignature, "base64url");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new Error("telemetry token is invalid");
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as
    Partial<TelemetryTokenClaims>;
  if (
    claims.v !== TOKEN_VERSION
    || claims.aud !== AUDIENCE
    || !Number.isSafeInteger(claims.userId)
    || (claims.userId ?? 0) <= 0
    || typeof claims.sandboxId !== "string"
    || !claims.sandboxId
    || !Number.isSafeInteger(claims.exp)
  ) {
    throw new Error("telemetry token has invalid claims");
  }
  if (claims.exp! <= Math.floor(nowMs / 1000)) {
    throw new Error("telemetry token expired");
  }
  return claims as TelemetryTokenClaims;
}
