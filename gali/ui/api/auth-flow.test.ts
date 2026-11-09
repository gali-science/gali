import { beforeEach, expect, test, vi } from "vitest";

const getSession = vi.fn();
const getUserById = vi.fn();
const resolveSandbox = vi.fn();
const retrySandbox = vi.fn();
const routeSandbox = vi.fn();

vi.mock("./_lib/auth.js", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}));

vi.mock("./_lib/sandbox-resolve.js", () => ({
  resolveSandbox: (...args: unknown[]) => resolveSandbox(...args),
  retrySandbox: (...args: unknown[]) => retrySandbox(...args),
  routeSandbox: (...args: unknown[]) => routeSandbox(...args),
}));
vi.mock("./_lib/users.js", () => ({
  getUserById: (...args: unknown[]) => getUserById(...args),
  hasCurrentModelConsent: (user: { consentVersion?: number | null }) =>
    user.consentVersion === 1,
}));

type Captured = {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status: (code: number) => Captured;
  json: (value: unknown) => Captured;
  setHeader: () => Captured;
  end: () => void;
};

function mockRes(): Captured {
  const res: Captured = {
    statusCode: 0,
    body: undefined,
    headersSent: false,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(value) {
      res.body = value;
      return res;
    },
    setHeader() {
      return res;
    },
    end() {},
  };
  return res;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  getSession.mockReset();
  getUserById.mockReset();
  resolveSandbox.mockReset();
  retrySandbox.mockReset();
  routeSandbox.mockReset();
  getSession.mockResolvedValue(null);
});

test("an unauthenticated ensure never reaches sandbox provisioning", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { default: sandbox } = await import("./sandbox.js");
  const res = mockRes();
  await sandbox(
    { method: "POST", headers: {}, query: { op: "ensure" } } as never,
    res as never,
  );
  expect(res.statusCode).toBe(401);
  expect(retrySandbox).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an unauthenticated proxy call never reaches a user sandbox", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const { default: proxy } = await import("./gali-proxy.js");
  const res = mockRes();
  await proxy({ method: "GET", headers: {}, query: {}, url: "/projects" } as never, res as never);
  expect(res.statusCode).toBe(401);
  expect(routeSandbox).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("a verified Clerk identity provisions only its internal user", async () => {
  getSession.mockResolvedValue({ userId: 23, clerkUserId: "user_23" });
  getUserById.mockResolvedValue({ id: 23, consentVersion: 1 });
  retrySandbox.mockResolvedValue({ sandboxId: "sbx-23", host: "https://sandbox.test" });
  const { default: sandbox } = await import("./sandbox.js");
  const res = mockRes();
  await sandbox(
    { method: "POST", headers: {}, query: { op: "ensure" } } as never,
    res as never,
  );
  expect(retrySandbox).toHaveBeenCalledWith(23);
  expect(res.body).toEqual({ status: "ready", sandboxId: "sbx-23" });
});

function streamRes() {
  const lines: unknown[] = [];
  const res = {
    ...mockRes(),
    headers: {} as Record<string, string>,
    ended: false,
    write(chunk: string) {
      for (const line of chunk.split("\n").filter(Boolean)) lines.push(JSON.parse(line));
      return true;
    },
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.setHeader = ((name: string, value: string) => {
    res.headers[name] = value;
    return res;
  }) as never;
  res.end = () => {
    res.ended = true;
  };
  return { res, lines };
}

const streamReq = {
  method: "POST",
  headers: { accept: "application/x-ndjson, application/json" },
  query: { op: "ensure" },
};

test("a streamed ensure reports each wake phase once, then ready", async () => {
  getSession.mockResolvedValue({ userId: 23, clerkUserId: "user_23" });
  getUserById.mockResolvedValue({ id: 23, consentVersion: 1 });
  const { reportWakeProgress } = await import("./_lib/wake-progress.js");
  retrySandbox.mockImplementation(async () => {
    reportWakeProgress("waking");
    reportWakeProgress("updating");
    reportWakeProgress("updating");
    reportWakeProgress("starting");
    return { sandboxId: "sbx-23", host: "https://sandbox.test" };
  });
  const { default: sandbox } = await import("./sandbox.js");
  const { res, lines } = streamRes();
  await sandbox(streamReq as never, res as never);
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toBe("application/x-ndjson");
  expect(lines).toEqual([
    { type: "progress", phase: "waking" },
    { type: "progress", phase: "updating" },
    { type: "progress", phase: "starting" },
    { type: "ready", sandboxId: "sbx-23" },
  ]);
  expect(res.ended).toBe(true);
});

test("a streamed ensure that fails carries the typed error in its last line", async () => {
  getSession.mockResolvedValue({ userId: 23, clerkUserId: "user_23" });
  getUserById.mockResolvedValue({ id: 23, consentVersion: 1 });
  const { SandboxUnavailableError } = await import("./_lib/sandbox-provider/types.js");
  const failure = { kind: "server_failed", provider: "vercel", detail: "install exited 1" } as const;
  retrySandbox.mockRejectedValue(new SandboxUnavailableError(failure));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { default: sandbox } = await import("./sandbox.js");
  const { res, lines } = streamRes();
  await sandbox(streamReq as never, res as never);
  expect(lines.at(-1)).toMatchObject({
    type: "failed",
    status: 503,
    body: { error: "sandbox_unavailable", failure },
  });
  expect(res.ended).toBe(true);
});

test("an ensure that cannot start the sandbox says why", async () => {
  getSession.mockResolvedValue({ userId: 23, clerkUserId: "user_23" });
  getUserById.mockResolvedValue({ id: 23, consentVersion: 1 });
  const { SandboxUnavailableError } = await import("./_lib/sandbox-provider/types.js");
  const failure = { kind: "start_failed", provider: "vercel", detail: "sandbox b is failed_to_start (internal_error)" } as const;
  retrySandbox.mockRejectedValue(new SandboxUnavailableError(failure));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { default: sandbox } = await import("./sandbox.js");
  const res = mockRes();
  await sandbox(
    { method: "POST", headers: {}, query: { op: "ensure" } } as never,
    res as never,
  );
  expect(res.statusCode).toBe(503);
  expect(res.body).toMatchObject({ error: "sandbox_unavailable", failure });
});
