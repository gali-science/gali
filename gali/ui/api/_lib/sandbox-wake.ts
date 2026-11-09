// Getting the Gali server up in a live sandbox. The source tree lives on the
// sandbox's disk; production replaces stale /app from the release artifact
// before starting Gali. /gali-data always stays untouched.

import {
  mintModelGatewayToken,
  mintSandboxCapabilityToken,
  SANDBOX_TOKEN_TTL_SECONDS,
} from "./model-gateway-token.js";
import {
  SandboxCommandError,
  SandboxFileNotFoundError,
  type LiveSandbox,
  type SandboxBoot,
} from "./sandbox-provider/index.js";
import { sandboxHttpHeaders, sandboxHttpSecret } from "./sandbox-http-auth.js";
import {
  INSTALL_LOCK,
  installCurrentSandboxRelease,
  installedSandboxReleaseVersion,
  sandboxReleaseIsCurrent,
} from "./sandbox-release.js";
import { timeWakePhase } from "./operational-log.js";
import { mintTelemetryToken } from "./telemetry-token.js";
import { reportWakeProgress } from "./wake-progress.js";
import {
  TOGETHERLINK_CODEX_MODEL,
  TOGETHERLINK_FAST_MODEL,
  useTogetherLink,
} from "./togetherlink.js";

export const GALI_PORT = 8787;
// Output is redirected to a file rather than left on the exec's stream: the
// exec holds the process for its whole life, so nothing is attached to read it.
// Append: a second ensureServer must not truncate the living loop's log.
// serve-loop itself is a singleton; extras exit 0 if a loop already holds the lock.
export const SERVER_SCRIPT =
  "cd /app && exec pnpm exec tsx scripts/serve-loop.ts >>/tmp/gali-http.log 2>&1";
export const CLEAR_CODEX_AUTH_SCRIPT =
  "rm -f /root/.codex/auth.json /gali-data/codex/auth.json /gali-data/codex-homes/*/auth.json";
// Older base images shipped a Codex hook that denies spawn_agent; the reviewer
// needs it for background reviews, and snapshots keep the file until removed.
export const REMOVE_SPAWN_GUARD_SCRIPT =
  "rm -rf /etc/codex/requirements.toml /opt/gali/codex-hooks";
// Codex can write the shared temp dirs; on the root disk they would sit outside
// the /gali-data cap and land in every snapshot. Memory-backed and bounded
// instead, and emptied by every cold boot.
export const MOUNT_TMP_SCRIPT =
  `mountpoint -q /tmp || mount -t tmpfs -o size=256m,mode=1777,nosuid,nodev tmpfs /tmp
mountpoint -q /var/tmp || mount --bind /tmp /var/tmp
mountpoint -q /run/lock || mount -t tmpfs -o size=1m,mode=1777,nosuid,nodev,noexec tmpfs /run/lock`;
const PORT_OPEN_SCRIPT =
  `if (exec 3<>/dev/tcp/127.0.0.1/${GALI_PORT}) 2>/dev/null; then echo open; else echo closed; fi`;
// When the running server's tokens expire. Only trusted on a warm wake: a cold
// boot always restarts the server, so a copy restored from disk never counts.
const CREDENTIALS_EXPIRY_PATH = "/tmp/gali-credentials-expire-at";
export const STOP_SERVER_SCRIPT =
  `self=$$
for file in /proc/[0-9]*/cmdline; do
  [ -f "$file" ] || continue
  pid=\${file#/proc/}
  pid=\${pid%/cmdline}
  [ "$pid" = "$self" ] && continue
  command=$(tr '\\0' ' ' < "$file") || continue
  case "$command" in
    *scripts/serve*) kill "$pid" || true ;;
  esac
done
sleep 2
rm -rf /tmp/gali-serve.lock
rm -f /gali-data/postmaster.pid`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is not set`);
  return value.trim();
}

function optionalEnv(name: string): Record<string, string> {
  const value = process.env[name]?.trim();
  return value ? { [name]: value } : {};
}

/**
 * Env handed to the Gali server process. Image-level statics live in
 * /etc/profile.d/gali.sh; these are the per-deployment secrets and the
 * sandbox's own identity, which only exists after the sandbox is created.
 */
export function serverEnv(
  userId: number,
  sandboxId: string,
  backendVersion?: string | null,
): Record<string, string> {
  const modelGatewayUrl = requireEnv("GALI_MODEL_GATEWAY_URL").replace(/\/$/, "");
  const telemetryEnabled = Boolean(process.env.GALI_TELEMETRY_SECRET?.trim());
  return {
    GALI_DATA: "/gali-data",
    CODEX_HOME: "/root/.codex",
    GALI_HTTP_PORT: String(GALI_PORT),
    GALI_SANDBOX_ID: sandboxId,
    ...(backendVersion ? { GALI_BACKEND_VERSION: backendVersion } : {}),
    GALI_MODEL_GATEWAY_URL: modelGatewayUrl,
    GALI_MODEL_GATEWAY_TOKEN: mintModelGatewayToken(userId, sandboxId),
    GALI_HTTP_SECRET: sandboxHttpSecret(userId, sandboxId),
    ...(telemetryEnabled
      ? {
          GALI_TELEMETRY_URL: `${new URL(modelGatewayUrl).origin}/api/telemetry`,
          GALI_TELEMETRY_TOKEN: mintTelemetryToken(userId, sandboxId),
        }
      : {}),
    ...(useTogetherLink()
      ? {
          GALI_GATEWAY_CODEX_MODEL: TOGETHERLINK_CODEX_MODEL,
          GALI_FAST_MODEL: TOGETHERLINK_FAST_MODEL,
        }
      : {}),
    ...optionalEnv("GALI_SLEEP_URL"),
    ...(process.env.GALI_SLEEP_URL?.trim()
      ? { GALI_SLEEP_TOKEN: mintSandboxCapabilityToken("sleep", userId, sandboxId) }
      : {}),
  };
}

export type ReadySandbox = { id: string; host: string };

/** The sandbox is up but the Gali server in it would not install or turn healthy. */
export class GaliServerError extends Error {
  constructor(readonly detail: string, options?: { cause: unknown }) {
    super(`gali server failed: ${detail}`, options);
    this.name = "GaliServerError";
  }
}

/**
 * How the sandbox reached ensureServer. A wake may have restored a server
 * whose credentials or release are stale; attach found one already running
 * within the deadline its wake set.
 */
export type ServerOrigin =
  | { via: "wake"; boot: SandboxBoot; awakeForMs: number }
  | { via: "attach" };

async function healthStatus(
  sbx: LiveSandbox,
  host: string,
  userId: number,
): Promise<"healthy" | "unauthorized" | "unavailable"> {
  try {
    const res = await fetch(`${host}/health`, {
      headers: sandboxHttpHeaders(userId, sbx.id),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return "healthy";
    return res.status === 401 ? "unauthorized" : "unavailable";
  } catch {
    return "unavailable";
  }
}

async function portOpen(sbx: LiveSandbox): Promise<boolean> {
  return (await sbx.run(PORT_OPEN_SCRIPT)).trim() === "open";
}

async function credentialsOutlive(sbx: LiveSandbox, deadlineMs: number): Promise<boolean> {
  try {
    return Number(await sbx.readFile(CREDENTIALS_EXPIRY_PATH)) > deadlineMs;
  } catch (error) {
    if (error instanceof SandboxFileNotFoundError) return false;
    throw error;
  }
}

/**
 * Why the server must be (re)started, or null to keep what is running. A port
 * that is open but unhealthy is a crash-looping serve-loop, which is still the
 * singleton: starting another piles PGlite openers on /gali-data.
 */
async function restartReason(
  sbx: LiveSandbox,
  userId: number,
  host: string,
  origin: ServerOrigin,
): Promise<string | null> {
  if (origin.via === "wake" && origin.boot === "cold") return "cold-boot";
  if (!(await portOpen(sbx))) return "not-listening";
  if ((await healthStatus(sbx, host, userId)) === "unauthorized") return "unauthorized";
  if (origin.via === "attach") return null;
  if (!(await credentialsOutlive(sbx, Date.now() + origin.awakeForMs))) return "credentials-expiring";
  if (!(await sandboxReleaseIsCurrent(sbx))) return "release-outdated";
  return null;
}

async function startServer(sbx: LiveSandbox, userId: number): Promise<void> {
  await timeWakePhase(
    "install-release",
    { userId, sandboxId: sbx.id },
    () => installCurrentSandboxRelease(sbx),
    (installed) => (installed ? "installed" : "current"),
  );
  const backendVersion = await installedSandboxReleaseVersion(sbx);
  const credentialsExpireAt = Date.now() + SANDBOX_TOKEN_TTL_SECONDS * 1000;
  const env = serverEnv(userId, sbx.id, backendVersion);
  await sbx.writeFile(CREDENTIALS_EXPIRY_PATH, String(credentialsExpireAt));
  reportWakeProgress("starting");
  await sbx.spawn(SERVER_SCRIPT, { env });
}

/** Starts or restarts the Gali server when needed, then waits until it is healthy. */
export async function ensureServer(
  sbx: LiveSandbox,
  userId: number,
  origin: ServerOrigin,
): Promise<ReadySandbox> {
  await sbx.run(CLEAR_CODEX_AUTH_SCRIPT);
  await sbx.run(REMOVE_SPAWN_GUARD_SCRIPT);
  const host = sbx.url(GALI_PORT);
  const ids = { userId, sandboxId: sbx.id };
  const reason = await timeWakePhase(
    `restart-check:${origin.via}`,
    ids,
    () => restartReason(sbx, userId, host, origin),
    (found) => found ?? "keep",
  );
  // A lock restored from the snapshot names a pid from before the boot, which
  // may now belong to an unrelated process and would stall every install.
  if (reason === "cold-boot") {
    await sbx.run(MOUNT_TMP_SCRIPT);
    await sbx.run(`rm -rf ${INSTALL_LOCK}`);
  }
  if (reason) {
    if (await portOpen(sbx)) {
      console.info("[sandbox-release] stopping restored server", { sandboxId: sbx.id, reason });
      await timeWakePhase("stop-server", ids, () => sbx.run(STOP_SERVER_SCRIPT, { timeoutMs: 30_000 }));
    }
    try {
      await startServer(sbx, userId);
    } catch (error) {
      if (error instanceof SandboxCommandError) {
        throw new GaliServerError(`install exited ${error.exitCode ?? "unknown"}`, { cause: error });
      }
      throw error;
    }
  }
  await timeWakePhase("health-wait", ids, () => waitForHealth(sbx, host, userId));
  return { id: sbx.id, host };
}

async function waitForHealth(
  sbx: LiveSandbox,
  host: string,
  userId: number,
  attempts = 120,
): Promise<void> {
  const headers = sandboxHttpHeaders(userId, sbx.id);
  let last = "no response";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`${host}/health`, { headers });
      if (res.ok) return;
      last = `${res.status} ${(await res.text()).slice(0, 120)}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new GaliServerError(`never became healthy: ${last}`);
}

/** Diagnostics for a sandbox whose server refuses to come up. */
export async function serverLog(sbx: LiveSandbox): Promise<string> {
  return sbx.run("tail -n 40 /tmp/gali-http.log 2>/dev/null || echo 'no log'");
}
