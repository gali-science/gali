import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LiveSandbox } from "../gali/ui/api/_lib/sandbox-provider/index.js";
import { GALI_ROOT, GALI_SOURCE as SOURCE } from "./image.js";

export function galiSourceVersion(): string {
  const repository = path.resolve(GALI_ROOT, "..");
  const revision = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  const trackedPaths = SOURCE.map((entry) => path.posix.join("gali", entry));
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...trackedPaths], {
    cwd: repository,
    encoding: "utf8",
  }).trim();
  return dirty ? `${revision}-dirty` : revision;
}

export function packGaliSource(): Buffer {
  const tarball = path.join(os.tmpdir(), "gali-src.tgz");
  execFileSync("tar", ["czf", tarball, "-C", GALI_ROOT, ...SOURCE], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  return fs.readFileSync(tarball);
}

/**
 * Pushes the local Gali tree into a sandbox for manual operations. Production
 * wakes use the equivalent versioned Blob artifact.
 */
export async function uploadGaliSource(sbx: LiveSandbox): Promise<number> {
  const bytes = packGaliSource();
  await sbx.writeFile("/tmp/gali-src.tgz", bytes);
  await sbx.run("mkdir -p /app && tar xzf /tmp/gali-src.tgz -C /app");
  await sbx.writeFile("/app/.gali-version", `${galiSourceVersion()}\n`);
  return bytes.length;
}
