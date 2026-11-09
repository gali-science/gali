import crypto from "node:crypto";

function masterKey(): string {
  const value = process.env.GALI_SANDBOX_HTTP_MASTER_KEY;
  if (!value?.trim()) throw new Error("GALI_SANDBOX_HTTP_MASTER_KEY is not set");
  return value.trim();
}

export function sandboxHttpSecret(userId: number, sandboxId: string): string {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("userId is invalid");
  if (!sandboxId.trim()) throw new Error("sandboxId is required");
  return crypto
    .createHmac("sha256", masterKey())
    .update(`gali-sandbox-http:v1:${userId}:${sandboxId}`)
    .digest("base64url");
}

/** Everything a request to the sandbox's Gali server must carry to get through. */
export function sandboxHttpHeaders(userId: number, sandboxId: string): Record<string, string> {
  return { "x-gali-secret": sandboxHttpSecret(userId, sandboxId) };
}
