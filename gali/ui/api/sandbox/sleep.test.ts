import { beforeEach, expect, test, vi } from "vitest";
import type { User } from "../_lib/db/schema.js";
import type { SandboxProvider } from "../_lib/sandbox-provider/index.js";

const authenticateSandboxToken = vi.fn();
const sleep = vi.fn<SandboxProvider["sleep"]>();

vi.mock("../_lib/users.js", () => ({
  markAsleep: vi.fn(),
}));

vi.mock("../_lib/sandbox-gateway-auth.js", () => ({
  authenticateSandboxToken: (...args: unknown[]) => authenticateSandboxToken(...args),
}));

vi.mock("../_lib/auth.js", () => ({
  getSession: vi.fn(),
}));

vi.mock("../_lib/sandbox-resolve.js", () => ({
  resolveSandbox: vi.fn(),
  forgetCached: vi.fn(),
}));

vi.mock("../_lib/sandbox-provider/index.js", () => ({
  sandboxProvider: () => ({ sleep }),
}));

vi.mock("../_lib/db/client.js", () => ({
  db: () => ({
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({
          returning: async () => [],
        }),
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
  }),
}));

type Captured = {
  statusCode: number;
  body: unknown;
  headersSent: boolean;
  status: (code: number) => Captured;
  json: (value: unknown) => Captured;
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
  };
  return res;
}

function user(): User {
  return {
    id: 1,
    clerkUserId: "user_alice",
    identityEmail: "alice@example.com",
    displayName: "Alice",
    sandboxProvider: "vercel",
    sandboxHome: "gali-user-alice",
    sandboxId: "box-1",
    sandboxHost: "https://box-1.test",
    wakeClaimAt: null,
    wakeFailure: null,
    wakeFailureAt: null,
    notificationEmail: null,
    trialSpentMicros: 0,
    consentVersion: null,
    voiceOpenAiAccepted: false,
    experimentsTogetherAccepted: false,
    consentAcceptedAt: null,
    createdAt: new Date(),
    lastLoginAt: null,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  authenticateSandboxToken.mockResolvedValue(user());
  sleep.mockResolvedValue(undefined);
});

test("an invalid sleep token is rejected before touching the provider", async () => {
  authenticateSandboxToken.mockResolvedValue(null);

  const { default: sandbox } = await import("../sandbox.js");
  const res = mockRes();
  await sandbox(
    {
      method: "POST",
      query: { op: "sleep" },
      headers: { authorization: "Bearer nope" },
      body: { sandboxId: "box-1" },
    } as never,
    res as never,
  );

  expect(res.statusCode).toBe(401);
  expect(sleep).not.toHaveBeenCalled();
});

test("a token cannot sleep a different sandbox", async () => {

  const { default: sandbox } = await import("../sandbox.js");
  const res = mockRes();
  await sandbox(
    {
      method: "POST",
      query: { op: "sleep" },
      headers: { authorization: "Bearer sleep-token" },
      body: { sandboxId: "not-mine" },
    } as never,
    res as never,
  );

  expect(res.statusCode).toBe(403);
  expect(sleep).not.toHaveBeenCalled();
});

test("sleeping hands the home to its provider, then marks the user asleep", async () => {
  const { markAsleep } = await import("../_lib/users.js");

  const { default: sandbox } = await import("../sandbox.js");
  const res = mockRes();
  await sandbox(
    {
      method: "POST",
      query: { op: "sleep" },
      headers: { authorization: "Bearer sleep-token" },
      body: { sandboxId: "box-1" },
    } as never,
    res as never,
  );

  expect(res.statusCode).toBe(200);
  expect(sleep).toHaveBeenCalledWith("gali-user-alice", "box-1");
  expect(markAsleep).toHaveBeenCalledWith(1);
  expect(vi.mocked(markAsleep).mock.invocationCallOrder[0]).toBeGreaterThan(
    sleep.mock.invocationCallOrder[0]!,
  );
  expect(res.body).toEqual({ slept: true, sandboxId: "box-1" });
});

test("a provider that fails to sleep leaves the user awake and reports failure", async () => {
  const { markAsleep } = await import("../_lib/users.js");
  sleep.mockRejectedValue(new Error("snapshot alias did not advance"));

  const { default: sandbox } = await import("../sandbox.js");
  const res = mockRes();
  await sandbox(
    {
      method: "POST",
      query: { op: "sleep" },
      headers: { authorization: "Bearer sleep-token" },
      body: { sandboxId: "box-1" },
    } as never,
    res as never,
  );

  expect(res.statusCode).toBe(500);
  expect(markAsleep).not.toHaveBeenCalled();
});
