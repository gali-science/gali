import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { UserError } from "./user-error.js";

const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_DOWNLOADED_BYTES = 2 * 1024 * 1024 * 1024;

async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += (await fsp.lstat(path.join(entry.parentPath, entry.name))).size;
  }
  return total;
}

// codeload only serves archives, so hosted sandboxes can reach it without
// being able to push anything out, which github.com would allow.
export function githubArchiveUrl(cloneUrl: string): string {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\.git$/.exec(cloneUrl);
  if (!match) throw new Error(`not a GitHub clone URL: ${cloneUrl}`);
  return `https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/HEAD`;
}

async function extract(body: ReadableStream<Uint8Array>, destination: string): Promise<void> {
  await fsp.mkdir(destination, { recursive: true });
  // The archive's own modes would override the umask and keep files from the
  // hosted Codex user's group.
  const tar = spawn("tar", ["-xz", "--strip-components=1", "--no-same-owner", "--no-same-permissions", "-C", destination], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  tar.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve, reject) => {
    tar.on("error", reject);
    tar.on("close", resolve);
  });
  await pipeline(Readable.fromWeb(body as never), tar.stdin);
  const code = await exited;
  if (code !== 0) throw new Error(`tar exited ${code}: ${stderr.trim().split("\n").at(-1)}`);
}

/** Downloads the default branch of a public repository into `destination` (which must not exist), without .git. */
export async function downloadRepository(cloneUrl: string, destination: string): Promise<void> {
  try {
    const res = await fetch(githubArchiveUrl(cloneUrl), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await extract(res.body, destination);
  } catch (error) {
    await fsp.rm(destination, { recursive: true, force: true });
    throw new UserError(`could not download ${cloneUrl} (public repositories only): ${error instanceof Error ? error.message : String(error)}`);
  }
  if ((await treeBytes(destination)) > MAX_DOWNLOADED_BYTES) {
    await fsp.rm(destination, { recursive: true, force: true });
    throw new UserError("the repository exceeds 2 GiB");
  }
}
