import { GALI_CONFIG } from "../../../shared/config.js";
import type { User } from "./db/schema.js";
import { errorFields, logOperationalEvent, timeWakePhase } from "./operational-log.js";
import { sandboxProvider } from "./sandbox-provider/index.js";
import {
  SandboxBusyError,
  SandboxUnavailableError,
  type LiveSandbox,
  type SandboxFailure,
} from "./sandbox-provider/types.js";
import { ensureServer, GaliServerError, GALI_PORT, serverLog, type ServerOrigin } from "./sandbox-wake.js";
import {
  claimWake,
  getUserById,
  markAsleep,
  markAwake,
  moveToProvider,
  recordWakingSandbox,
  releaseWakeClaim,
  sandboxOwnerForClerkUser,
  wakeInProgress,
} from "./users.js";
import { reportWakeProgress } from "./wake-progress.js";

export type ResolvedSandbox = {
  sandboxId: string;
  host: string;
};

type CacheEntry = ResolvedSandbox & { resolvedAt: number };

// Every proxied request would otherwise re-check the sandbox with its provider
// and add a round trip. 60s is short enough that a sleep a user just triggered
// is noticed quickly.
const cache = new Map<number, CacheEntry>();
const CACHE_TTL_MS = 60_000;

const WAKE_POLL_ATTEMPTS = 120;
const WAKE_POLL_MS = 500;

const FAILURE_COOLDOWN_MS = 60_000;

function cacheable(userId: number, resolved: ResolvedSandbox): ResolvedSandbox {
  cache.set(userId, { ...resolved, resolvedAt: Date.now() });
  return resolved;
}

async function requireUser(userId: number): Promise<User> {
  const user = await getUserById(userId);
  if (!user) throw new Error(`no account for userId ${userId}`);
  return user;
}

/**
 * The config picks the provider for everyone. An account whose home lives on
 * another provider starts over on the configured one: the old home is
 * abandoned, and the next wake boots the starter.
 */
async function configuredUser(userId: number): Promise<User> {
  const user = await requireUser(userId);
  if (user.sandboxProvider === GALI_CONFIG.sandboxProvider) return user;
  await moveToProvider(userId, user.sandboxProvider, GALI_CONFIG.sandboxProvider);
  return requireUser(userId);
}

/**
 * Active-request fast path. Both values were written from the provider's
 * authenticated response during wake, so no provider, port or health request
 * is needed here.
 */
export async function routeSandbox(userId: number): Promise<ResolvedSandbox> {
  const user = await configuredUser(userId);
  if (user.sandboxId && user.sandboxHost) {
    return { sandboxId: user.sandboxId, host: user.sandboxHost };
  }
  return resolveSandbox(userId);
}

// userId, not the request: identity comes exclusively from the verified session
// (see auth.ts getSession) — never from a client-supplied header.
/** For background traffic: a home that just failed to wake reports that failure instead of retrying. */
export function resolveSandbox(userId: number): Promise<ResolvedSandbox> {
  return resolve(userId, false);
}

/** For a user asking to get in: wakes even a home that just failed. */
export function retrySandbox(userId: number): Promise<ResolvedSandbox> {
  return resolve(userId, true);
}

async function resolve(userId: number, retryFailed: boolean): Promise<ResolvedSandbox> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) return cached;

  const user = await configuredUser(userId);
  if (wakeInProgress(user)) return cacheable(userId, await waitForOtherWake(userId));
  if (user.sandboxId) {
    const running = await attachRunning(user, user.sandboxId);
    if (running) return cacheable(userId, running);
    // Crashed, evicted, or slept without telling us. The home still holds the
    // disk, so waking again is the recovery path.
    await markAsleep(userId);
  }

  const failure = recentFailure(user);
  if (failure && !retryFailed) throw new SandboxUnavailableError(failure);

  if (await claimWake(userId)) {
    try {
      return cacheable(userId, await wake(user));
    } catch (error) {
      await releaseWakeClaim(userId, error instanceof SandboxUnavailableError ? error.failure : null);
      throw error;
    }
  }

  // Someone else is waking this user. A second wake could create a second home
  // or fork the first, so wait for the winner instead.
  return cacheable(userId, await waitForOtherWake(userId));
}

function waitForOtherWake(userId: number): Promise<ResolvedSandbox> {
  reportWakeProgress("waiting");
  return timeWakePhase("await-other-wake", { userId }, () => awaitOtherWake(userId));
}

// A home that failed to start keeps failing for a while. Without this, every
// RPC and stream reconnect from an open tab would create another sandbox.
function recentFailure(user: User): SandboxFailure | null {
  if (!user.wakeFailure || !user.wakeFailureAt) return null;
  return Date.now() - user.wakeFailureAt.getTime() < FAILURE_COOLDOWN_MS ? user.wakeFailure : null;
}

// A server that will not come up is the user's to see and retry, like a
// sandbox that will not boot; its log is ours to read.
async function serveGali(user: User, sandbox: LiveSandbox, origin: ServerOrigin) {
  try {
    return await ensureServer(sandbox, user.id, origin);
  } catch (error) {
    if (!(error instanceof GaliServerError)) throw error;
    logOperationalEvent({
      eventName: "sandbox.process.crashed",
      level: "error",
      userId: user.id,
      sandboxId: sandbox.id,
      ...errorFields(new Error(`${error.message}\n${await serverLog(sandbox).catch(String)}`)),
    });
    throw new SandboxUnavailableError({ kind: "server_failed", provider: user.sandboxProvider, detail: error.detail });
  }
}

async function attachRunning(user: User, sandboxId: string): Promise<ResolvedSandbox | null> {
  if (!user.sandboxHome) throw new Error(`user ${user.id} has sandbox ${sandboxId} but no home`);
  const sandbox = await timeWakePhase(
    "provider-attach",
    { userId: user.id, sandboxId },
    () => sandboxProvider(user.sandboxProvider).attach(sandboxId),
    (found) => (found ? "running" : "gone"),
  );
  if (!sandbox) return null;
  const ready = await serveGali(user, sandbox, { via: "attach" });
  await markAwake(user.id, { home: user.sandboxHome, sandboxId: ready.id, host: ready.host });
  return { sandboxId: ready.id, host: ready.host };
}

async function wake(user: User): Promise<ResolvedSandbox> {
  const provider = sandboxProvider(user.sandboxProvider);
  reportWakeProgress("waking");
  const woken = await timeWakePhase(
    "provider-wake",
    { userId: user.id },
    () => provider.wake(user.sandboxHome, sandboxOwnerForClerkUser(user.clerkUserId)),
    (result) => `${user.sandboxProvider}:${result.boot}${user.sandboxHome ? "" : ":new-home"}`,
  );
  // Recorded before the server is up: a crash between here and health means
  // the next request finds this sandbox and reuses it instead of leaking it,
  // and a newly created home is never orphaned. The claim is kept until the
  // server is healthy, or a waiter would start a second install on top.
  const waking = {
    home: woken.home,
    sandboxId: woken.sandbox.id,
    host: woken.sandbox.url(GALI_PORT),
  };
  await recordWakingSandbox(user.id, waking);
  const ready = await serveGali(user, woken.sandbox, {
    via: "wake",
    boot: woken.boot,
    awakeForMs: provider.maxAwakeMs,
  });
  await markAwake(user.id, { ...waking, sandboxId: ready.id, host: ready.host });
  return { sandboxId: ready.id, host: ready.host };
}

// Every released claim overwrites wakeFailure, so once the claim is gone it
// describes the wake this request waited on.
async function awaitOtherWake(userId: number): Promise<ResolvedSandbox> {
  for (let attempt = 0; attempt < WAKE_POLL_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, WAKE_POLL_MS));
    const user = await requireUser(userId);
    if (wakeInProgress(user)) continue;
    if (user.sandboxId) {
      const running = await attachRunning(user, user.sandboxId);
      if (running) return running;
    }
    if (user.wakeFailure) throw new SandboxUnavailableError(user.wakeFailure);
    throw new Error(`the wake this request waited on for userId ${userId} failed`);
  }
  throw new SandboxBusyError(`another request is still waking userId ${userId}`);
}

export function forgetCached(userId: number): void {
  cache.delete(userId);
}
