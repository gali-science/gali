import { createClerkClient } from "@clerk/backend";
import type { VercelRequest } from "@vercel/node";
import {
  getUserByClerkUserId,
  materializeClerkUser,
} from "./users.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is not set on Vercel`);
  return value.trim();
}

function listEnv(name: string): string[] {
  const values = requireEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} has no values`);
  return values;
}

function requestUrl(req: Pick<VercelRequest, "headers" | "url">): string {
  const forwardedHost = req.headers["x-forwarded-host"];
  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0] ?? req.headers.host ?? "localhost:5178"
    : forwardedHost ?? req.headers.host ?? "localhost:5178";
  const forwardedProto = req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto ?? (host.startsWith("localhost") ? "http" : "https");
  return new URL(req.url ?? "/", `${proto}://${host}`).toString();
}

function webRequest(req: Pick<VercelRequest, "headers" | "method" | "url">): Request {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(req.headers)) {
    if (raw === undefined) continue;
    headers.set(name, Array.isArray(raw) ? raw.join(", ") : raw);
  }
  return new Request(requestUrl(req), {
    method: req.method ?? "GET",
    headers,
  });
}

function displayName(firstName: string | null, lastName: string | null, email: string): string {
  const joined = [firstName, lastName].filter(Boolean).join(" ").trim();
  return joined || email.slice(0, email.lastIndexOf("@"));
}

async function localDevelopmentSession(): Promise<{
  userId: number;
  clerkUserId: string;
} | null> {
  if (process.env.VITE_GALI_DEV_AUTH_BYPASS !== "1") return null;
  if (process.env.VERCEL?.trim()) {
    throw new Error("VITE_GALI_DEV_AUTH_BYPASS cannot be enabled on Vercel");
  }
  const clerkUserId = "local-development";
  const user = await materializeClerkUser({
    clerkUserId,
    identityEmail: "local@gali.dev",
    displayName: "Local scientist",
  });
  return { userId: user.id, clerkUserId };
}

export type Session = { userId: number; clerkUserId: string };
export type AccessDenied = { denied: string };

export async function getSession(
  req: Pick<VercelRequest, "headers" | "method" | "url">,
): Promise<Session | AccessDenied | null> {
  const localSession = await localDevelopmentSession();
  if (localSession) return localSession;

  const publishableKey = requireEnv("CLERK_PUBLISHABLE_KEY");
  const secretKey = requireEnv("CLERK_SECRET_KEY");
  const clerk = createClerkClient({ publishableKey, secretKey });
  const state = await clerk.authenticateRequest(webRequest(req), {
    acceptsToken: "session_token",
    authorizedParties: listEnv("CLERK_AUTHORIZED_PARTIES"),
    jwtKey: requireEnv("CLERK_JWT_KEY").replaceAll("\\n", "\n"),
  });
  if (!state.isAuthenticated) {
    if (state.reason !== "session-token-and-uat-missing") {
      console.warn(`[gali] auth rejected: ${state.reason}${state.message ? ` (${state.message})` : ""}`);
    }
    return null;
  }

  const clerkUserId = state.toAuth().userId;
  const existing = await getUserByClerkUserId(clerkUserId);
  if (existing) return { userId: existing.id, clerkUserId };

  const identity = await clerk.users.getUser(clerkUserId);
  const primary = identity.emailAddresses.find(
    (email) => email.id === identity.primaryEmailAddressId,
  );
  if (!primary) throw new Error(`Clerk user ${clerkUserId} has no primary email`);
  if (primary.verification?.status !== "verified") {
    console.warn(`[gali] auth rejected: email unverified for ${clerkUserId}`);
    return { denied: "Verify your email address with the sign-in provider, then sign in again." };
  }

  const user = await materializeClerkUser({
    clerkUserId,
    identityEmail: primary.emailAddress.toLowerCase(),
    displayName: displayName(identity.firstName, identity.lastName, primary.emailAddress),
  });
  return { userId: user.id, clerkUserId };
}
