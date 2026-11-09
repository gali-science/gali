export type ActivityTracker = ReturnType<typeof createActivityTracker>;

export type IdleSnapshot = {
  now: number;
  lastActivityAt: number;
  idleAfterMs: number;
  inFlightRequests: number;
  activeReviews: number;
};

// A sleep cuts the reviewer mid-turn, so a turn in flight always outranks the
// idle clock. The thread itself lives on disk and resumes after the wake.
export function shouldSleep(snapshot: IdleSnapshot): boolean {
  if (snapshot.inFlightRequests > 0) return false;
  if (snapshot.activeReviews > 0) return false;
  return snapshot.now - snapshot.lastActivityAt >= snapshot.idleAfterMs;
}

export function createActivityTracker(now: () => number = Date.now) {
  let lastActivityAt = now();
  let inFlightRequests = 0;

  // Clamped at zero: an unpaired decrement would otherwise leave a negative
  // count that blocks sleeping for the life of the process.
  return {
    touch() {
      lastActivityAt = now();
    },
    requestStarted() {
      inFlightRequests += 1;
      lastActivityAt = now();
    },
    requestFinished() {
      inFlightRequests = Math.max(0, inFlightRequests - 1);
      lastActivityAt = now();
    },
    snapshot(activeReviews: number, idleAfterMs: number): IdleSnapshot {
      return { now: now(), lastActivityAt, idleAfterMs, inFlightRequests, activeReviews };
    },
  };
}

export function startIdleSleepWatcher(opts: {
  tracker: ActivityTracker;
  activeReviews: () => number;
  // Sent in the sleep body: with one sandbox per user, the sleep endpoint has no
  // other way to know which sandbox is calling it.
  sandboxId: string;
  sleepUrl: string;
  sleepToken: string;
  idleAfterMs: number;
  checkEveryMs: number;
  log?: (message: string) => void;
  onFailure?: (error: unknown) => void;
}): () => void {
  const log = opts.log ?? ((message: string) => console.log(`[idle] ${message}`));
  let sleeping = false;

  const checkIdle = async () => {
    if (sleeping) return;
    const snapshot = opts.tracker.snapshot(opts.activeReviews(), opts.idleAfterMs);
    if (!shouldSleep(snapshot)) return;

    sleeping = true;
    const idleMinutes = Math.round((snapshot.now - snapshot.lastActivityAt) / 60_000);
    log(`idle ${idleMinutes}m, no review running — requesting sleep`);
    // Restart the clock before asking, so a refused or failed sleep doesn't
    // re-fire on every tick.
    opts.tracker.touch();
    try {
      const res = await fetch(opts.sleepUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.sleepToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sandboxId: opts.sandboxId, reason: `idle ${idleMinutes}m` }),
        signal: AbortSignal.timeout(30_000),
      });
      log(`sleep request -> ${res.status}`);
      if (!res.ok && res.status !== 409) opts.onFailure?.(new Error(`sleep request failed with HTTP ${res.status}`));
    } catch (error) {
      // The successful path lands here too: this VM is terminated mid-fetch.
      // Swallowing is required, otherwise `sleeping` never clears and the
      // watcher is dead for the rest of the process.
      log(`sleep request ended: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      sleeping = false;
    }
  };
  const timer = setInterval(() => {
    void checkIdle().catch((error: unknown) => {
      sleeping = false;
      opts.onFailure?.(error);
      log(`idle check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, opts.checkEveryMs);
  timer.unref();

  return () => clearInterval(timer);
}
