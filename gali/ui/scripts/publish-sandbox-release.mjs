import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import console from "node:console";
import process from "node:process";
import { put } from "@vercel/blob";

const galiRoot = path.resolve(import.meta.dirname, "../..");
const source = [
  "src",
  "shared",
  "drizzle",
  "scripts",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "drizzle.config.ts",
];
const maxArchiveBytes = 64 * 1024 * 1024;

if (process.env.VERCEL === "1" && !process.env.VERCEL_ENV) {
  throw new Error("VERCEL_ENV is unavailable; enable Vercel system environment variables");
}
if (process.env.VERCEL_ENV !== "production") {
  console.log("[sandbox-release] skipped outside production");
  process.exit(0);
}

const version = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
if (!version || !/^[0-9a-f]{40}$/i.test(version)) {
  throw new Error("VERCEL_GIT_COMMIT_SHA is missing or invalid");
}

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "gali-release-"));
const archivePath = path.join(temporaryDirectory, "app.tgz");

try {
  execFileSync(
    "tar",
    ["czf", archivePath, "-C", galiRoot, ...source],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } },
  );
  const archive = fs.readFileSync(archivePath);
  if (archive.byteLength > maxArchiveBytes) {
    throw new Error(`sandbox release exceeds ${maxArchiveBytes} bytes`);
  }
  const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
  const pathname = `sandbox-releases/${version}/${sha256}.tgz`;
  await put(pathname, archive, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/gzip",
  });
  const release = { version, pathname, sha256, size: archive.byteLength };
  await put(
    `sandbox-releases/${version}/manifest.json`,
    JSON.stringify(release),
    {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    },
  );
  console.log(`[sandbox-release] published ${pathname} (${archive.byteLength} bytes)`);
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
