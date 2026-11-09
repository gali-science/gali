import crypto from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { GALI_CONFIG } from "../../../shared/config.js";
import { db } from "./db/client.js";
import { users, type User } from "./db/schema.js";
import type { SandboxFailure, SandboxProviderKind } from "./sandbox-provider/types.js";

export const MODEL_CONSENT_VERSION = 1;

export function hasCurrentModelConsent(user: User): boolean {
  return (
    user.consentVersion === MODEL_CONSENT_VERSION
    && user.voiceOpenAiAccepted
    && user.experimentsTogetherAccepted
  );
}

// A wake takes ~20s. Past this a claim is assumed dead (crashed function) and
// another request may take over rather than leaving the user stuck asleep.
const WAKE_CLAIM_TTL_MS = 3 * 60_000;

export type AwakeSandbox = { home: string; sandboxId: string; host: string };

// Stable, non-secret label a provider names and tags the user's home with.
export function sandboxOwnerForClerkUser(clerkUserId: string): string {
  const suffix = crypto.createHash("sha256").update(clerkUserId).digest("hex").slice(0, 24);
  return process.env.VERCEL_ENV === "preview" ? `gali-preview-user-${suffix}` : `gali-user-${suffix}`;
}

export async function getUserByClerkUserId(clerkUserId: string): Promise<User | null> {
  const rows = await db().select().from(users).where(eq(users.clerkUserId, clerkUserId)).limit(1);
  return rows[0] ?? null;
}

export async function getUserById(userId: number): Promise<User | null> {
  const rows = await db().select().from(users).where(eq(users.id, userId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Tries to become the one request that wakes this user. Succeeds only when the
 * user is asleep and nobody else holds a fresh claim; losers should poll for
 * `sandboxId` instead of waking a second sandbox from the same snapshot.
 */
export async function claimWake(userId: number): Promise<boolean> {
  const staleBefore = new Date(Date.now() - WAKE_CLAIM_TTL_MS);
  const rows = await db()
    .update(users)
    .set({ wakeClaimAt: new Date() })
    .where(
      and(
        eq(users.id, userId),
        isNull(users.sandboxId),
        or(isNull(users.wakeClaimAt), lt(users.wakeClaimAt, staleBefore)),
      ),
    )
    .returning({ id: users.id });
  return rows.length > 0;
}

/** Whether a live request is still waking this user, so nobody else may touch the sandbox yet. */
export function wakeInProgress(user: User): boolean {
  return user.wakeClaimAt !== null && Date.now() - user.wakeClaimAt.getTime() < WAKE_CLAIM_TTL_MS;
}

/**
 * Records the sandbox a wake just created while the wake still holds its claim,
 * so a crash before the server is healthy cannot leak it, and nobody else
 * starts a second server on it meanwhile.
 */
export async function recordWakingSandbox(
  userId: number,
  waking: AwakeSandbox,
): Promise<void> {
  await db()
    .update(users)
    .set({
      sandboxHome: waking.home,
      sandboxId: waking.sandboxId,
      sandboxHost: waking.host,
    })
    .where(eq(users.id, userId));
}

export async function markAwake(
  userId: number,
  awake: AwakeSandbox,
): Promise<void> {
  await db()
    .update(users)
    .set({
      sandboxHome: awake.home,
      sandboxId: awake.sandboxId,
      sandboxHost: awake.host,
      wakeClaimAt: null,
      wakeFailure: null,
      wakeFailureAt: null,
    })
    .where(eq(users.id, userId));
}

export async function markAsleep(userId: number): Promise<void> {
  await db()
    .update(users)
    .set({ sandboxId: null, sandboxHost: null, wakeClaimAt: null })
    .where(eq(users.id, userId));
}

/**
 * Re-homes the account on another provider with no home, so its next wake
 * boots the starter there. The old home is abandoned, not migrated. Guarded on
 * the old provider so concurrent requests reset it once.
 */
export async function moveToProvider(
  userId: number,
  from: SandboxProviderKind,
  to: SandboxProviderKind,
): Promise<void> {
  await db()
    .update(users)
    .set({
      sandboxProvider: to,
      sandboxHome: null,
      sandboxId: null,
      sandboxHost: null,
      wakeClaimAt: null,
      wakeFailure: null,
      wakeFailureAt: null,
    })
    .where(and(eq(users.id, userId), eq(users.sandboxProvider, from)));
}

/** Gives up a failed wake. `failure` is null when the cause was not the provider's to report. */
export async function releaseWakeClaim(userId: number, failure: SandboxFailure | null): Promise<void> {
  await db()
    .update(users)
    .set({ wakeClaimAt: null, wakeFailure: failure, wakeFailureAt: failure ? new Date() : null })
    .where(eq(users.id, userId));
}

export async function materializeClerkUser(input: {
  clerkUserId: string;
  identityEmail: string;
  displayName: string;
}): Promise<User> {
  const rows = await db()
    .insert(users)
    .values({
      clerkUserId: input.clerkUserId,
      identityEmail: input.identityEmail,
      displayName: input.displayName,
      sandboxProvider: GALI_CONFIG.sandboxProvider,
      lastLoginAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.clerkUserId,
      set: {
        identityEmail: input.identityEmail,
        displayName: input.displayName,
        lastLoginAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error(`materializeClerkUser(${input.clerkUserId}) returned no row`);
  return row;
}

export async function acceptModelConsentById(
  userId: number,
  version: number,
): Promise<User> {
  const rows = await db()
    .update(users)
    .set({
      consentVersion: version,
      voiceOpenAiAccepted: true,
      experimentsTogetherAccepted: true,
      consentAcceptedAt: new Date(),
    })
    .where(eq(users.id, userId))
    .returning();
  const row = rows[0];
  if (!row) throw new Error(`acceptModelConsentById: no user id ${userId}`);
  return row;
}
