import {
  type SandboxCapabilityAudience,
  verifySandboxCapabilityToken,
} from "./model-gateway-token.js";
import { getUserById } from "./users.js";
import type { User } from "./db/schema.js";

export async function authenticateSandboxToken(
  token: string,
  audience: SandboxCapabilityAudience,
): Promise<User | null> {
  let claims;
  try {
    claims = verifySandboxCapabilityToken(token.trim(), audience);
  } catch {
    return null;
  }
  const user = await getUserById(claims.userId);
  if (!user || user.sandboxId !== claims.sandboxId) return null;
  return user;
}
