import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SandboxCommandError, SandboxFileNotFoundError, SandboxUnavailableError } from "../types.js";

vi.mock("@vercel/sandbox", () => {
  class APIError extends Error {
    constructor(readonly response: { status: number }) {
      super(`HTTP ${response.status}`);
    }
  }
  return {
    APIError,
    Sandbox: { create: vi.fn(), get: vi.fn() },
    Drive: { getOrCreate: vi.fn(), get: vi.fn() },
  };
});

const HOUR_MS = 60 * 60_000;

function session() {
  return {
    domain: (port: number) => `https://sb-${port}.vercel.run`,
    runCommand: vi.fn(),
    readFileToBuffer: vi.fn(),
    writeFiles: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
  };
}

function handle(status: string, live = session()) {
  return { status, currentSession: () => live, delete: vi.fn() };
}

function finished(exitCode: number, output: string) {
  return { exitCode, output: vi.fn(async () => output) };
}

async function notFound() {
  const { APIError } = await import("@vercel/sandbox");
  return new (APIError as unknown as new (response: { status: number }) => Error)({ status: 404 });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GALI_MODEL_GATEWAY_URL", "https://gali.example/api/model-gateway");
  vi.stubEnv("GALI_SLEEP_URL", "https://sleep.example/api/sandbox/sleep");
  vi.stubEnv("GALI_SANDBOX_IMAGE", "vcr.vercel.com/team/gali/gali-starter:v1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const STANDING = ["gali.example", "pypi.org", "files.pythonhosted.org", "codeload.github.com", "sleep.example"];

test("a first wake creates a capped drive and a persistent sandbox behind the allow-list", async () => {
  const { Drive, Sandbox } = await import("@vercel/sandbox");
  const drive = { name: "drive" };
  vi.mocked(Drive.getOrCreate).mockResolvedValue(drive as never);
  vi.mocked(Sandbox.create).mockResolvedValue(handle("running") as never);
  const { vercelProvider } = await import("./provider.js");

  const woken = await vercelProvider.wake(null, "gali-user-alice");

  expect(woken.home).toMatch(/^gali-user-alice-[0-9a-z]+$/);
  expect(woken).toMatchObject({ boot: "cold", sandbox: { id: woken.home } });
  expect(Drive.getOrCreate).toHaveBeenCalledWith({ name: woken.home, maxSize: 1024 ** 3 });
  expect(Sandbox.create).toHaveBeenCalledWith({
    name: woken.home,
    image: "vcr.vercel.com/team/gali/gali-starter:v1",
    ports: [8787],
    resources: { vcpus: 2 },
    timeout: HOUR_MS,
    persistent: true,
    snapshotExpiration: 0,
    keepLastSnapshots: { count: 1 },
    networkPolicy: { allow: STANDING },
    mounts: { "/gali-data": drive },
    tags: { app: "gali", owner: "gali-user-alice" },
  });
});

test("waking an existing home resumes it cold and reapplies the allow-list", async () => {
  const { Sandbox } = await import("@vercel/sandbox");
  const live = session();
  vi.mocked(Sandbox.get).mockResolvedValue(handle("running", live) as never);
  const { vercelProvider } = await import("./provider.js");

  const woken = await vercelProvider.wake("home-1", "gali-user-alice");

  expect(Sandbox.get).toHaveBeenCalledWith({ name: "home-1", resume: true });
  expect(live.update).toHaveBeenCalledWith({ networkPolicy: { allow: STANDING } });
  expect(Sandbox.create).not.toHaveBeenCalled();
  expect(woken).toMatchObject({ home: "home-1", boot: "cold", sandbox: { id: "home-1" } });
  expect(woken.sandbox.url(8787)).toBe("https://sb-8787.vercel.run");
});

test("a home that no longer exists is home_missing, not a fresh start", async () => {
  const { Sandbox } = await import("@vercel/sandbox");
  vi.mocked(Sandbox.get).mockRejectedValue(await notFound());
  const { vercelProvider } = await import("./provider.js");

  const failure = await vercelProvider.wake("home-gone", "gali-user-alice").catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(SandboxUnavailableError);
  expect((failure as SandboxUnavailableError).failure).toMatchObject({ kind: "home_missing", provider: "vercel" });
  expect(Sandbox.create).not.toHaveBeenCalled();
});

test("attach never resumes and finds nothing unless the sandbox is running", async () => {
  const { Sandbox } = await import("@vercel/sandbox");
  const { vercelProvider } = await import("./provider.js");

  vi.mocked(Sandbox.get).mockResolvedValueOnce(handle("stopped") as never);
  await expect(vercelProvider.attach("home-1")).resolves.toBeNull();
  vi.mocked(Sandbox.get).mockRejectedValueOnce(await notFound());
  await expect(vercelProvider.attach("home-1")).resolves.toBeNull();
  vi.mocked(Sandbox.get).mockResolvedValueOnce(handle("running") as never);
  await expect(vercelProvider.attach("home-1")).resolves.toMatchObject({ id: "home-1" });

  expect(vi.mocked(Sandbox.get).mock.calls.every(([params]) => !("resume" in params))).toBe(true);
});

test("commands go through the session, and a failing one throws with its output", async () => {
  const { vercelSandbox } = await import("./provider.js");
  const live = session();
  const sbx = vercelSandbox("home-1", live as never);

  live.runCommand.mockResolvedValueOnce(finished(0, "ok\n"));
  await expect(sbx.run("echo ok", { env: { A: "1" }, cwd: "/app" })).resolves.toBe("ok\n");
  expect(live.runCommand).toHaveBeenLastCalledWith({
    cmd: "bash", args: ["-lc", "echo ok"], env: { A: "1" }, cwd: "/app", timeoutMs: 300_000,
  });

  live.runCommand.mockResolvedValueOnce(finished(2, "boom"));
  const failure = await sbx.run("false").catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SandboxCommandError);
  expect(failure).toMatchObject({ exitCode: 2, output: "boom" });

  live.runCommand.mockResolvedValueOnce({});
  await sbx.spawn("serve", { env: { B: "2" } });
  expect(live.runCommand).toHaveBeenLastCalledWith({
    cmd: "bash", args: ["-lc", "serve"], env: { B: "2" }, cwd: undefined, detached: true,
  });
});

test("files round-trip and a missing one is SandboxFileNotFoundError", async () => {
  const { vercelSandbox } = await import("./provider.js");
  const live = session();
  const sbx = vercelSandbox("home-1", live as never);

  live.readFileToBuffer.mockResolvedValueOnce(Buffer.from("hello"));
  await expect(sbx.readFile("/tmp/a")).resolves.toBe("hello");
  live.readFileToBuffer.mockResolvedValueOnce(null);
  await expect(sbx.readFile("/tmp/b")).rejects.toBeInstanceOf(SandboxFileNotFoundError);

  await sbx.writeFile("/tmp/c", "text");
  expect(live.writeFiles).toHaveBeenCalledWith([{ path: "/tmp/c", content: Buffer.from("text") }]);
});

test("an egress window adds hosts only while its work runs, even when it fails", async () => {
  const { vercelSandbox } = await import("./provider.js");
  const live = session();
  const sbx = vercelSandbox("home-1", live as never);

  await expect(sbx.withEgress(["registry.npmjs.org"], async () => {
    throw new Error("install failed");
  })).rejects.toThrow("install failed");

  expect(live.update.mock.calls).toEqual([
    [{ networkPolicy: { allow: [...STANDING, "registry.npmjs.org"] } }],
    [{ networkPolicy: { allow: STANDING } }],
  ]);
});

test("sleep stops only a running sandbox", async () => {
  const { Sandbox } = await import("@vercel/sandbox");
  const { vercelProvider } = await import("./provider.js");
  const running = handle("running");
  const stopped = handle("stopped");

  vi.mocked(Sandbox.get).mockResolvedValueOnce(running as never);
  await vercelProvider.sleep("home-1", "home-1");
  vi.mocked(Sandbox.get).mockResolvedValueOnce(stopped as never);
  await vercelProvider.sleep("home-1", null);

  expect(running.currentSession().stop).toHaveBeenCalledOnce();
  expect(stopped.currentSession().stop).not.toHaveBeenCalled();
});

test("destroy deletes the sandbox, its snapshots and then its drive", async () => {
  const { Drive, Sandbox } = await import("@vercel/sandbox");
  const sbx = handle("running");
  const drive = { delete: vi.fn() };
  vi.mocked(Sandbox.get).mockResolvedValue(sbx as never);
  vi.mocked(Drive.get).mockResolvedValue(drive as never);
  const { vercelProvider } = await import("./provider.js");

  await vercelProvider.destroy("home-1", "home-1");

  expect(sbx.currentSession().stop).toHaveBeenCalledOnce();
  expect(sbx.delete).toHaveBeenCalledWith({ deleteOrphanSnapshots: true });
  expect(Drive.get).toHaveBeenCalledWith({ name: "home-1" });
  expect(drive.delete).toHaveBeenCalledOnce();
});
