import crypto from "node:crypto";

const TOKEN_VERSION = 1;
// Longer than any provider keeps a sandbox awake, so credentials minted when the
// server starts last until the provider stops it. Wakes enforce this.
export const SANDBOX_TOKEN_TTL_SECONDS = 25 * 60 * 60;

export type SandboxCapabilityAudience =
  | "model"
  | "sleep";

export type SandboxCapabilityClaims = {
  v: typeof TOKEN_VERSION;
  aud: SandboxCapabilityAudience;
  userId: number;
  sandboxId: string;
  exp: number;
};

function signingSecret(): string {
  const value = process.env.GALI_MODEL_GATEWAY_SECRET;
  if (!value?.trim()) throw new Error("GALI_MODEL_GATEWAY_SECRET is not set");
  return value.trim();
}

function signature(payload: string): Buffer {
  return crypto.createHmac("sha256", signingSecret()).update(payload).digest();
}

export function mintSandboxCapabilityToken(
  audience: SandboxCapabilityAudience,
  userId: number,
  sandboxId: string,
  nowMs = Date.now(),
): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("userId is invalid");
  if (!sandboxId.trim()) throw new Error("sandboxId is required");
  const claims: SandboxCapabilityClaims = {
    v: TOKEN_VERSION,
    aud: audience,
    userId,
    sandboxId,
    exp: Math.floor(nowMs / 1000) + SANDBOX_TOKEN_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifySandboxCapabilityToken(
  token: string,
  expectedAudience: SandboxCapabilityAudience,
  nowMs = Date.now(),
): SandboxCapabilityClaims {
  if (token.length > 4096) throw new Error("model gateway token is invalid");
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("model gateway token is invalid");
  }
  const expected = signature(parts[0]);
  const provided = Buffer.from(parts[1], "base64url");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) {
    throw new Error("model gateway token is invalid");
  }
  const claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as
    Partial<SandboxCapabilityClaims>;
  if (
    claims.v !== TOKEN_VERSION
    || claims.aud !== expectedAudience
    || !Number.isSafeInteger(claims.userId)
    || (claims.userId ?? 0) <= 0
    || typeof claims.sandboxId !== "string"
    || !claims.sandboxId
    || !Number.isSafeInteger(claims.exp)
  ) {
    throw new Error("model gateway token has invalid claims");
  }
  if (claims.exp! <= Math.floor(nowMs / 1000)) {
    throw new Error("model gateway token expired");
  }
  return claims as SandboxCapabilityClaims;
}

export function mintModelGatewayToken(
  userId: number,
  sandboxId: string,
  nowMs = Date.now(),
): string {
  return mintSandboxCapabilityToken("model", userId, sandboxId, nowMs);
}

export function verifyModelGatewayToken(
  token: string,
  nowMs = Date.now(),
): SandboxCapabilityClaims {
  return verifySandboxCapabilityToken(token, "model", nowMs);
}
