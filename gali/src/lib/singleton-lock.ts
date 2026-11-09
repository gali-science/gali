import fs from "node:fs";
import path from "node:path";

export const SERVE_LOCK_DIR = "/tmp/gali-serve.lock";
export const DEFAULT_STALE_MS = 15_000;
export const DEFAULT_HEARTBEAT_MS = 3_000;

export type SingletonLock = {
  release: () => void;
};

export function tryAcquireSingletonLock(
  lockDir: string,
  options: { now?: number; staleMs?: number; heartbeatMs?: number } = {},
): SingletonLock | null {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!acquireDir(lockDir, now, staleMs)) return null;
  const heartbeat = path.join(lockDir, "heartbeat");
  writeHeartbeat(heartbeat);
  const timer = setInterval(() => writeHeartbeat(heartbeat), heartbeatMs);
  timer.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    fs.rmSync(lockDir, { recursive: true, force: true });
  };
  return { release };
}

function acquireDir(lockDir: string, now: number, staleMs: number): boolean {
  try {
    fs.mkdirSync(lockDir);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!isStale(lockDir, now, staleMs)) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    try {
      fs.mkdirSync(lockDir);
      return true;
    } catch (retry) {
      if ((retry as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw retry;
    }
  }
}

function isStale(lockDir: string, now: number, staleMs: number): boolean {
  const heartbeat = path.join(lockDir, "heartbeat");
  try {
    return now - fs.statSync(heartbeat).mtimeMs > staleMs;
  } catch {
    try {
      return now - fs.statSync(lockDir).mtimeMs > staleMs;
    } catch {
      return true;
    }
  }
}

function writeHeartbeat(file: string): void {
  fs.writeFileSync(file, `${process.pid}\n${Date.now()}\n`);
}
