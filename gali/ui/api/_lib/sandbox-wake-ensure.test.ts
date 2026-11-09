import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SandboxFileNotFoundError, type LiveSandbox } from "./sandbox-provider/index.js";
import type { ServerOrigin } from "./sandbox-wake.js";

const installCurrentSandboxRelease = vi.fn();
const installedSandboxReleaseVersion = vi.fn();
const sandboxReleaseIsCurrent = vi.fn();

vi.mock("./sandbox-release.js", () => ({
  INSTALL_LOCK: "/tmp/gali-release.lock",
  installCurrentSandboxRelease: (...args: unknown[]) => installCurrentSandboxRelease(...args),
  installedSandboxReleaseVersion: (...args: unknown[]) => installedSandboxReleaseVersion(...args),
  sandboxReleaseIsCurrent: (...args: unknown[]) => sandboxReleaseIsCurrent(...args),
}));

const HOUR_MS = 60 * 60_000;
const CREDENTIALS_PATH = "/tmp/gali-credentials-expire-at";

function fakeSandbox(state: { portOpen: boolean; files?: Record<string, string> }) {
  const files = new Map(Object.entries(state.files ?? {}));
  const sandbox = {
    id: "box-1",
    url: (port: number) => `https://${port}-box-1.sandbox.test`,
    withEgress: <T,>(_hosts: readonly string[], work: () => Promise<T>) => work(),
    run: vi.fn(async (script: string) =>
      script.includes("/dev/tcp/") ? (state.portOpen ? "open\n" : "closed\n") : ""
    ),
    spawn: vi.fn(async () => undefined),
    readFile: vi.fn(async (path: string) => {
      const contents = files.get(path);
      if (contents === undefined) throw new SandboxFileNotFoundError(path);
      return contents;
    }),
    writeFile: vi.fn(async (path: string, contents: string | Uint8Array) => {
      files.set(path, String(contents));
    }),
  } satisfies LiveSandbox;
  return sandbox;
}

function freshCredentials(validForMs: number): Record<string, string> {
  return { [CREDENTIALS_PATH]: String(Date.now() + validForMs) };
}

const WARM: ServerOrigin = { via: "wake", boot: "warm", awakeForMs: 24 * HOUR_MS };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GALI_MODEL_GATEWAY_SECRET = "signing-secret";
  process.env.GALI_SANDBOX_HTTP_MASTER_KEY = "http-master-key";
  process.env.GALI_MODEL_GATEWAY_URL = "https://gali.example/api/model/v1";
  installCurrentSandboxRelease.mockResolvedValue(true);
  installedSandboxReleaseVersion.mockResolvedValue("release-version");
  sandboxReleaseIsCurrent.mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GALI_MODEL_GATEWAY_SECRET;
  delete process.env.GALI_SANDBOX_HTTP_MASTER_KEY;
  delete process.env.GALI_MODEL_GATEWAY_URL;
});

test("a cold boot replaces a restored server before starting Gali", async () => {
  const sandbox = fakeSandbox({ portOpen: true });
  const { ensureServer, STOP_SERVER_SCRIPT, SERVER_SCRIPT } = await import("./sandbox-wake.js");

  await expect(ensureServer(sandbox, 7, { via: "wake", boot: "cold", awakeForMs: 24 * HOUR_MS }))
    .resolves.toEqual({ id: "box-1", host: "https://8787-box-1.sandbox.test" });

  expect(sandbox.run).toHaveBeenCalledWith(STOP_SERVER_SCRIPT, { timeoutMs: 30_000 });
  expect(sandbox.run).toHaveBeenCalledWith("rm -rf /tmp/gali-release.lock");
  expect(installCurrentSandboxRelease).toHaveBeenCalledWith(sandbox);
  expect(sandbox.spawn).toHaveBeenCalledOnce();
  expect(sandbox.spawn).toHaveBeenCalledWith(SERVER_SCRIPT, {
    env: expect.objectContaining({ GALI_BACKEND_VERSION: "release-version", GALI_SANDBOX_ID: "box-1" }),
  });
  expect(installCurrentSandboxRelease.mock.invocationCallOrder[0]).toBeLessThan(
    sandbox.spawn.mock.invocationCallOrder[0]!,
  );
});

test("starting the server records when its credentials expire", async () => {
  const sandbox = fakeSandbox({ portOpen: false });
  const { ensureServer } = await import("./sandbox-wake.js");

  await ensureServer(sandbox, 7, { via: "wake", boot: "cold", awakeForMs: 24 * HOUR_MS });

  const expiresAt = Number(await sandbox.readFile(CREDENTIALS_PATH));
  expect(expiresAt).toBeGreaterThan(Date.now() + 24 * HOUR_MS);
});

test("an attached sandbox restarts when its HTTP credential is stale", async () => {
  const sandbox = fakeSandbox({ portOpen: true });
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
    .mockResolvedValueOnce(new Response("ok")));
  const { ensureServer, STOP_SERVER_SCRIPT } = await import("./sandbox-wake.js");

  await ensureServer(sandbox, 7, { via: "attach" });

  expect(sandbox.run).toHaveBeenCalledWith(STOP_SERVER_SCRIPT, { timeoutMs: 30_000 });
  expect(sandbox.spawn).toHaveBeenCalledOnce();
});

test("a healthy attached sandbox is left running", async () => {
  const sandbox = fakeSandbox({ portOpen: true });
  const { ensureServer } = await import("./sandbox-wake.js");

  await ensureServer(sandbox, 7, { via: "attach" });

  expect(installCurrentSandboxRelease).not.toHaveBeenCalled();
  expect(sandboxReleaseIsCurrent).not.toHaveBeenCalled();
  expect(sandbox.spawn).not.toHaveBeenCalled();
});

test("a warm wake keeps a server whose credentials outlive the wake", async () => {
  const sandbox = fakeSandbox({ portOpen: true, files: freshCredentials(25 * HOUR_MS) });
  const { ensureServer } = await import("./sandbox-wake.js");

  await ensureServer(sandbox, 7, WARM);

  expect(sandbox.spawn).not.toHaveBeenCalled();
});

test("a warm wake restarts a server whose credentials would expire while awake", async () => {
  const sandbox = fakeSandbox({ portOpen: true, files: freshCredentials(3 * HOUR_MS) });
  const { ensureServer, STOP_SERVER_SCRIPT } = await import("./sandbox-wake.js");

  await ensureServer(sandbox, 7, WARM);

  expect(sandbox.run).toHaveBeenCalledWith(STOP_SERVER_SCRIPT, { timeoutMs: 30_000 });
  expect(sandbox.spawn).toHaveBeenCalledOnce();
});

test("a warm wake restarts a server with no recorded credentials", async () => {
  const sandbox = fakeSandbox({ portOpen: true });
  const { ensureServer } = await import("./sandbox-wake.js");

  await ensureServer(sandbox, 7, WARM);

  expect(sandbox.spawn).toHaveBeenCalledOnce();
});

test("a warm wake restarts a server running an outdated release", async () => {
  const sandbox = fakeSandbox({ portOpen: true, files: freshCredentials(25 * HOUR_MS) });
  sandboxReleaseIsCurrent.mockResolvedValue(false);
  const { ensureServer } = await import("./sandbox-wake.js");

  await ensureServer(sandbox, 7, WARM);

  expect(installCurrentSandboxRelease).toHaveBeenCalledWith(sandbox);
  expect(sandbox.spawn).toHaveBeenCalledOnce();
});

test("a closed port starts the server without stopping anything", async () => {
  const sandbox = fakeSandbox({ portOpen: false });
  const { ensureServer, STOP_SERVER_SCRIPT } = await import("./sandbox-wake.js");

  await ensureServer(sandbox, 7, { via: "attach" });

  expect(sandbox.run).not.toHaveBeenCalledWith(STOP_SERVER_SCRIPT, expect.anything());
  expect(sandbox.spawn).toHaveBeenCalledOnce();
});

test("health checks carry the sandbox secret", async () => {
  const sandbox = fakeSandbox({ portOpen: false });
  const { ensureServer } = await import("./sandbox-wake.js");
  const { sandboxHttpSecret } = await import("./sandbox-http-auth.js");

  await ensureServer(sandbox, 7, { via: "wake", boot: "cold", awakeForMs: 24 * HOUR_MS });

  const health = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/health"));
  expect(health?.[1]?.headers).toEqual({ "x-gali-secret": sandboxHttpSecret(7, "box-1") });
});
