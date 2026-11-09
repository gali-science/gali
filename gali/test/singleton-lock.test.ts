import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { tryAcquireSingletonLock } from "../src/lib/singleton-lock.js";
import { clearStalePostmasterPid } from "../src/db/client.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function lockDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gali-lock-"));
  tmpDirs.push(dir);
  return path.join(dir, "serve.lock");
}

test("a second acquirer is refused while the lock is held", () => {
  const dir = lockDir();
  const first = tryAcquireSingletonLock(dir);
  expect(first).not.toBeNull();
  expect(tryAcquireSingletonLock(dir)).toBeNull();
  first!.release();
  const again = tryAcquireSingletonLock(dir);
  expect(again).not.toBeNull();
  again!.release();
});

test("a stale lock is stolen", () => {
  const dir = lockDir();
  fs.mkdirSync(dir);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(dir, past, past);
  const stolen = tryAcquireSingletonLock(dir, { staleMs: 15_000 });
  expect(stolen).not.toBeNull();
  stolen!.release();
});

test("a fresh heartbeat is not stolen", () => {
  const dir = lockDir();
  const first = tryAcquireSingletonLock(dir, { staleMs: 15_000 });
  expect(first).not.toBeNull();
  expect(tryAcquireSingletonLock(dir, { now: Date.now() + 5_000, staleMs: 15_000 })).toBeNull();
  first!.release();
});

test("clearStalePostmasterPid removes a leftover pid file", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gali-pg-"));
  tmpDirs.push(dataDir);
  const pid = path.join(dataDir, "postmaster.pid");
  fs.writeFileSync(pid, "-42\n");
  clearStalePostmasterPid(dataDir);
  expect(fs.existsSync(pid)).toBe(false);
  clearStalePostmasterPid(dataDir);
  clearStalePostmasterPid("memory://");
});
