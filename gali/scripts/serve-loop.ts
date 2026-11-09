import { spawn } from "node:child_process";
import path from "node:path";
import {
  SERVE_LOCK_DIR,
  tryAcquireSingletonLock,
} from "../src/lib/singleton-lock.js";

const serve = path.resolve(import.meta.dirname, "serve.ts");
const lockDir = process.env.GALI_SERVE_LOCK ?? SERVE_LOCK_DIR;
const lock = tryAcquireSingletonLock(lockDir);
if (!lock) {
  console.log("[serve-loop] already running; exiting");
  process.exit(0);
}

const release = () => lock.release();
process.on("exit", release);
process.on("SIGTERM", () => {
  release();
  process.exit(0);
});
process.on("SIGINT", () => {
  release();
  process.exit(0);
});

const MAX_DELAY_MS = 15_000;
let delayMs = 1_000;

for (;;) {
  console.log(`[serve-loop] starting ${serve}`);
  const child = spawn("pnpm", ["exec", "tsx", serve], {
    cwd: path.resolve(import.meta.dirname, ".."),
    stdio: "inherit",
    env: process.env,
  });
  const code: number | null = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c));
  });
  console.error(`[serve-loop] serve exited code=${code}; restarting in ${delayMs}ms`);
  await new Promise((r) => setTimeout(r, delayMs));
  delayMs = Math.min(delayMs * 2, MAX_DELAY_MS);
}
