import crypto from "node:crypto";
import { get } from "@vercel/blob";
import {
  SandboxCommandError,
  SandboxFileNotFoundError,
  type LiveSandbox,
} from "./sandbox-provider/index.js";
import { reportWakeProgress } from "./wake-progress.js";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4096;
export const INSTALL_LOCK = "/tmp/gali-release.lock";
const INSTALL_LOCK_WAIT_SECONDS = 240;
// Opened only for the install: an open npm registry would let Codex publish
// what it reads.
const RELEASE_INSTALL_HOSTS = ["registry.npmjs.org"];

export type SandboxRelease = {
  version: string;
  pathname: string;
  sha256: string;
  size: number;
};

function validateRelease(release: SandboxRelease): void {
  if (
    !/^[A-Za-z0-9._-]{1,80}$/.test(release.version)
    || !/^[0-9a-f]{64}$/i.test(release.sha256)
    || !Number.isSafeInteger(release.size)
    || release.size <= 0
    || release.size > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("sandbox release is invalid");
  }
}

export async function installedSandboxReleaseVersion(
  sbx: LiveSandbox,
): Promise<string | null> {
  try {
    return (await sbx.readFile("/app/.gali-version")).trim() || null;
  } catch (error) {
    if (error instanceof SandboxFileNotFoundError) return null;
    throw error;
  }
}

/** Whether the sandbox runs the release this deployment ships. Always true outside production. */
export async function sandboxReleaseIsCurrent(sbx: LiveSandbox): Promise<boolean> {
  const release = await currentRelease();
  return !release || (await installedSandboxReleaseVersion(sbx)) === release.version;
}

async function streamBytes(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  if (bytes.byteLength > maximumBytes) throw new Error("sandbox release object is too large");
  return bytes;
}

async function currentRelease(): Promise<SandboxRelease | null> {
  if (process.env.VERCEL_ENV !== "production") return null;
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (!version || !/^[0-9a-f]{40}$/i.test(version)) {
    throw new Error("VERCEL_GIT_COMMIT_SHA is missing or invalid");
  }
  const pathname = `sandbox-releases/${version}/manifest.json`;
  const result = await get(pathname, { access: "private" });
  if (!result || result.statusCode !== 200) {
    throw new Error(`sandbox release manifest is unavailable: ${pathname}`);
  }
  const raw = new TextDecoder().decode(
    await streamBytes(result.stream, MAX_MANIFEST_BYTES),
  );
  const release = JSON.parse(raw) as Partial<SandboxRelease>;
  if (
    release.version !== version
    || typeof release.sha256 !== "string"
    || !/^[0-9a-f]{64}$/i.test(release.sha256)
    || release.pathname !== `sandbox-releases/${version}/${release.sha256}.tgz`
    || !Number.isSafeInteger(release.size)
    || (release.size ?? 0) <= 0
    || (release.size ?? 0) > MAX_ARCHIVE_BYTES
  ) {
    throw new Error("sandbox release manifest is invalid");
  }
  const validated = release as SandboxRelease;
  validateRelease(validated);
  return validated;
}

async function releaseArchive(release: SandboxRelease): Promise<Uint8Array> {
  if (release.size <= 0 || release.size > MAX_ARCHIVE_BYTES) {
    throw new Error("sandbox release size is invalid");
  }
  const result = await get(release.pathname, { access: "private" });
  if (!result || result.statusCode !== 200) {
    throw new Error(`sandbox release blob is unavailable: ${release.pathname}`);
  }
  if (result.blob.size !== release.size) {
    throw new Error("sandbox release blob size does not match manifest");
  }
  const bytes = await streamBytes(result.stream, MAX_ARCHIVE_BYTES);
  if (bytes.byteLength !== release.size) {
    throw new Error("sandbox release download is incomplete");
  }
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== release.sha256) {
    throw new Error("sandbox release checksum does not match manifest");
  }
  return bytes;
}

// Two requests can reach the same sandbox at once. Each install swaps /app and
// sweeps stale /app.next.* trees, so a second one running alongside deletes the
// first's work mid-copy. The lock makes them take turns; a holder that died is
// detected by its pid, and whoever waited skips a version already in place.
export function installScript(version: string, sha256: string, archive: string): string {
  return `set -euo pipefail
archive=${archive}
lock=${INSTALL_LOCK}
next=
previous=
stage=lock
trap 'code=$?; echo "[sandbox-release] failed stage=$stage exit=$code"; exit $code' ERR

for ((waited = 0; waited < ${INSTALL_LOCK_WAIT_SECONDS}; waited++)); do
  if mkdir "$lock" 2>/dev/null; then
    echo $$ > "$lock/pid"
    break
  fi
  holder=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$lock"
    continue
  fi
  sleep 1
done
if [ "$(cat "$lock/pid" 2>/dev/null || true)" != "$$" ]; then
  echo "[sandbox-release] another install held the lock for ${INSTALL_LOCK_WAIT_SECONDS}s"
  exit 1
fi
trap 'rm -rf "$lock"; rm -f "$archive"' EXIT

if [ "$(cat /app/.gali-version 2>/dev/null || true)" = '${version}' ]; then
  echo "[sandbox-release] ${version} already installed"
  exit 0
fi

stage=prepare
next=$(mktemp -d /app.next.XXXXXX)
# mktemp makes it 0700; Codex runs as the agent user from /app/node_modules.
chmod 755 "$next"
if [ ! -d /app ]; then
  for candidate in /app.previous /app.previous.*; do
    [ -d "$candidate" ] || continue
    mv "$candidate" /app
    break
  done
fi
test -d /app

stage=checksum
printf '%s  %s\\n' '${sha256}' "$archive" | sha256sum -c -
stage=extract
tar xzf "$archive" -C "$next" --no-same-owner
test -f "$next/package.json"
test -f "$next/pnpm-lock.yaml"
test -f "$next/scripts/serve-loop.ts"

stage=dependencies
if [ -d /app/node_modules ] && cmp -s /app/pnpm-lock.yaml "$next/pnpm-lock.yaml"; then
  cp -al /app/node_modules "$next/node_modules"
else
  corepack enable
  cd "$next"
  pnpm install --frozen-lockfile --child-concurrency=1 --network-concurrency=8
fi

stage=swap
printf '%s\\n' '${version}' > "$next/.gali-version"
previous=$(mktemp -d /app.previous.XXXXXX)
rmdir "$previous"
mv /app "$previous"
if ! mv "$next" /app; then
  mv "$previous" /app
  exit 1
fi
if ! rm -rf "$previous"; then
  echo "[sandbox-release] warning: could not remove $previous"
fi
rm -f "$archive"
for stale in /app.next /app.next.* /app.previous /app.previous.*; do
  [ -e "$stale" ] || continue
  if ! rm -rf "$stale"; then
    echo "[sandbox-release] warning: could not remove $stale"
  fi
done
`;
}

export async function installCurrentSandboxRelease(
  sbx: LiveSandbox,
): Promise<boolean> {
  const startedAt = Date.now();
  const release = await currentRelease();
  if (!release) {
    console.info("[sandbox-release] disabled", { sandboxId: sbx.id });
    return false;
  }
  const installed = await installedSandboxReleaseVersion(sbx);
  console.info("[sandbox-release] checked", {
    sandboxId: sbx.id,
    installedVersion: installed,
    targetVersion: release.version,
  });
  if (installed === release.version) {
    console.info("[sandbox-release] current", {
      sandboxId: sbx.id,
      version: release.version,
    });
    return false;
  }
  reportWakeProgress("updating");
  console.info("[sandbox-release] downloading", {
    sandboxId: sbx.id,
    version: release.version,
    bytes: release.size,
  });
  const archive = await releaseArchive(release);
  await installSandboxReleaseArchive(sbx, release, archive);
  console.info("[sandbox-release] installed", {
    sandboxId: sbx.id,
    version: release.version,
    durationMs: Date.now() - startedAt,
  });
  return true;
}

export async function installSandboxReleaseArchive(
  sbx: LiveSandbox,
  release: SandboxRelease,
  archive: Uint8Array,
): Promise<void> {
  validateRelease(release);
  if (archive.byteLength !== release.size) {
    throw new Error("sandbox release archive size does not match");
  }
  const digest = crypto.createHash("sha256").update(archive).digest("hex");
  if (digest !== release.sha256) {
    throw new Error("sandbox release archive checksum does not match");
  }
  const archivePath = `/tmp/gali-release-${crypto.randomUUID()}.tgz`;
  await sbx.writeFile(archivePath, archive);
  console.info("[sandbox-release] installing", {
    sandboxId: sbx.id,
    version: release.version,
  });
  try {
    await sbx.withEgress(RELEASE_INSTALL_HOSTS, () =>
      sbx.run(installScript(release.version, release.sha256, archivePath), {
        timeoutMs: (INSTALL_LOCK_WAIT_SECONDS + 300) * 1000,
      }));
  } catch (error) {
    if (!(error instanceof SandboxCommandError)) throw error;
    throw new Error(
      `sandbox release install failed (${error.exitCode}): ` +
      `${error.output.trim().slice(-800) || "no command output"}`,
      { cause: error },
    );
  }
}
