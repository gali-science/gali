import crypto from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  SandboxCommandError,
  SandboxFileNotFoundError,
  type LiveSandbox,
} from "./sandbox-provider/index.js";

const get = vi.fn();

const archive = new TextEncoder().encode("release archive");
const sha256 = crypto.createHash("sha256").update(archive).digest("hex");
const version = "a".repeat(40);
const release = {
  version,
  pathname: `sandbox-releases/${version}/${sha256}.tgz`,
  sha256,
  size: archive.byteLength,
};

vi.mock("@vercel/blob", () => ({ get: (...args: unknown[]) => get(...args) }));

let openEgress: readonly string[] = [];
const sandbox = {
  id: "box-1",
  url: (port: number) => `https://${port}-box-1.sandbox.test`,
  async withEgress<T>(hosts: readonly string[], work: () => Promise<T>) {
    openEgress = hosts;
    try {
      return await work();
    } finally {
      openEgress = [];
    }
  },
  run: vi.fn<LiveSandbox["run"]>(),
  spawn: vi.fn<LiveSandbox["spawn"]>(),
  readFile: vi.fn<LiveSandbox["readFile"]>(),
  writeFile: vi.fn<LiveSandbox["writeFile"]>(),
} satisfies LiveSandbox;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VERCEL_ENV", "production");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", version);
  sandbox.readFile.mockRejectedValue(new SandboxFileNotFoundError("/app/.gali-version"));
  get.mockImplementation((pathname: string) => {
    const body = pathname.endsWith("/manifest.json")
      ? JSON.stringify(release)
      : archive;
    return Promise.resolve({
      statusCode: 200,
      stream: new Response(body).body,
      blob: { size: body.length },
    });
  });
  sandbox.writeFile.mockResolvedValue(undefined);
  sandbox.run.mockResolvedValue("");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

test("does not load sandbox releases outside production", async () => {
  vi.stubEnv("VERCEL_ENV", "preview");
  const { installCurrentSandboxRelease } = await import("./sandbox-release.js");

  await expect(installCurrentSandboxRelease(sandbox)).resolves.toBe(false);

  expect(get).not.toHaveBeenCalled();
});

test("skips the download when the installed release is current", async () => {
  sandbox.readFile.mockResolvedValue(`${version}\n`);
  const { installCurrentSandboxRelease } = await import("./sandbox-release.js");

  await expect(installCurrentSandboxRelease(sandbox)).resolves.toBe(false);

  expect(get).toHaveBeenCalledOnce();
  expect(get).toHaveBeenCalledWith(
    `sandbox-releases/${version}/manifest.json`,
    { access: "private" },
  );
  expect(sandbox.writeFile).not.toHaveBeenCalled();
});

test("reports whether the installed release is the one this deployment ships", async () => {
  const { sandboxReleaseIsCurrent } = await import("./sandbox-release.js");
  await expect(sandboxReleaseIsCurrent(sandbox)).resolves.toBe(false);

  sandbox.readFile.mockResolvedValue(`${version}\n`);
  await expect(sandboxReleaseIsCurrent(sandbox)).resolves.toBe(true);

  vi.stubEnv("VERCEL_ENV", "preview");
  sandbox.readFile.mockResolvedValue("anything-else\n");
  await expect(sandboxReleaseIsCurrent(sandbox)).resolves.toBe(true);
});

test("an unreadable version file fails instead of forcing a reinstall", async () => {
  sandbox.readFile.mockRejectedValue(new Error("sandbox unreachable"));
  const { installedSandboxReleaseVersion } = await import("./sandbox-release.js");

  await expect(installedSandboxReleaseVersion(sandbox)).rejects.toThrow("sandbox unreachable");
});

test("verifies and atomically installs a stale release", async () => {
  const egressDuringInstall: (readonly string[])[] = [];
  sandbox.run.mockImplementation(async () => {
    egressDuringInstall.push(openEgress);
    return "";
  });
  const { installCurrentSandboxRelease } = await import("./sandbox-release.js");

  await expect(installCurrentSandboxRelease(sandbox)).resolves.toBe(true);

  expect(egressDuringInstall).toEqual([["registry.npmjs.org"]]);
  expect(openEgress).toEqual([]);
  expect(get).toHaveBeenCalledWith(
    release.pathname,
    { access: "private" },
  );
  const archivePath = sandbox.writeFile.mock.calls[0]?.[0] as string;
  expect(archivePath).toMatch(/^\/tmp\/gali-release-[0-9a-f-]{36}\.tgz$/);
  expect(Array.from(sandbox.writeFile.mock.calls[0]?.[1] as Uint8Array)).toEqual(
    Array.from(archive),
  );
  const [script, options] = sandbox.run.mock.calls[0]!;
  expect(options).toEqual({ timeoutMs: 540_000 });
  expect(script).toContain(`archive=${archivePath}`);
  expect(script).toContain('mkdir "$lock"');
  expect(script).toContain("mv /app \"$previous\"");
  expect(script).toContain("sha256sum -c -");
  expect(script).toContain("mktemp -d /app.next.XXXXXX");
  expect(script).toContain('chmod 755 "$next"');
  expect(script).not.toContain('rm -rf "$next" "$previous"');
  expect(script).toContain("cmp -s /app/pnpm-lock.yaml");
  expect(script).toContain("cp -al /app/node_modules");
  expect(script).toContain("pnpm install --frozen-lockfile");
});

test("rejects a release whose digest does not match", async () => {
  get.mockImplementation((pathname: string) => {
    const body = pathname.endsWith("/manifest.json")
      ? JSON.stringify(release)
      : "release archivf";
    return Promise.resolve({
      statusCode: 200,
      stream: new Response(body).body,
      blob: { size: body.length },
    });
  });
  const { installCurrentSandboxRelease } = await import("./sandbox-release.js");

  await expect(installCurrentSandboxRelease(sandbox)).rejects.toThrow(
    /checksum does not match/,
  );
  expect(sandbox.writeFile).not.toHaveBeenCalled();
  expect(sandbox.run).not.toHaveBeenCalled();
});

test("surfaces the failed installation stage instead of the full script", async () => {
  sandbox.run.mockRejectedValue(new SandboxCommandError(
    "install",
    1,
    "[sandbox-release] failed stage=dependencies exit=1\n",
  ));
  const { installCurrentSandboxRelease } = await import("./sandbox-release.js");

  await expect(installCurrentSandboxRelease(sandbox)).rejects.toThrow(
    "sandbox release install failed (1): [sandbox-release] failed stage=dependencies exit=1",
  );
});
