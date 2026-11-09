import { beforeEach, expect, test, vi } from "vitest";
import type { User } from "./db/schema.js";
import type { LiveSandbox, SandboxProvider } from "./sandbox-provider/index.js";

vi.mock("./users.js", async (importOriginal) => ({
  sandboxOwnerForClerkUser: (await importOriginal<typeof import("./users.js")>()).sandboxOwnerForClerkUser,
  wakeInProgress: (await importOriginal<typeof import("./users.js")>()).wakeInProgress,
  getUserById: vi.fn(),
  claimWake: vi.fn(),
  recordWakingSandbox: vi.fn(),
  markAwake: vi.fn(),
  markAsleep: vi.fn(),
  moveToProvider: vi.fn(),
  releaseWakeClaim: vi.fn(),
}));

vi.mock("../../../shared/config.js", async (importOriginal) => {
  const { GALI_CONFIG } = await importOriginal<typeof import("../../../shared/config.js")>();
  return { GALI_CONFIG: { ...GALI_CONFIG, sandboxProvider: "vercel" } };
});

const provider = {
  kind: "vercel",
  maxAwakeMs: 24 * 60 * 60_000,
  keepsMemoryOnSleep: false,
  wake: vi.fn<SandboxProvider["wake"]>(),
  attach: vi.fn<SandboxProvider["attach"]>(),
  sleep: vi.fn<SandboxProvider["sleep"]>(),
  destroy: vi.fn<SandboxProvider["destroy"]>(),
} satisfies SandboxProvider;

vi.mock("./sandbox-provider/index.js", () => ({
  sandboxProvider: () => provider,
}));

vi.mock("./sandbox-wake.js", () => ({
  GALI_PORT: 8787,
  GaliServerError: class GaliServerError extends Error {
    constructor(readonly detail: string) {
      super(`gali server failed: ${detail}`);
    }
  },
  serverLog: vi.fn(async () => "serve-loop: PGlite lock held"),
  ensureServer: vi.fn(async (sandbox: LiveSandbox) => ({ id: sandbox.id, host: sandbox.url(8787) })),
}));

function user(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    clerkUserId: "user_alice",
    identityEmail: "alice@example.com",
    displayName: "Alice",
    sandboxProvider: "vercel",
    sandboxHome: "home-alice",
    sandboxId: null,
    sandboxHost: null,
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
    ...overrides,
  };
}

function sandbox(id: string): LiveSandbox {
  return {
    id,
    url: (port) => `https://${port}-${id}.sandbox.test`,
    withEgress: (_hosts, work) => work(),
    run: vi.fn(),
    spawn: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

test("an active route uses the trusted database host without calling the provider", async () => {
  const { getUserById } = await import("./users.js");
  const { ensureServer } = await import("./sandbox-wake.js");
  vi.mocked(getUserById).mockResolvedValue(user({
    sandboxId: "box-1",
    sandboxHost: "https://8787-box-1.sandbox.test",
  }));

  const { routeSandbox } = await import("./sandbox-resolve.js");
  await expect(routeSandbox(1)).resolves.toEqual({
    sandboxId: "box-1",
    host: "https://8787-box-1.sandbox.test",
  });
  expect(provider.attach).not.toHaveBeenCalled();
  expect(provider.wake).not.toHaveBeenCalled();
  expect(ensureServer).not.toHaveBeenCalled();
});

test("a running sandbox is attached without waking", async () => {
  const { getUserById, markAwake } = await import("./users.js");
  const { ensureServer } = await import("./sandbox-wake.js");
  vi.mocked(getUserById).mockResolvedValue(user({ sandboxId: "box-1" }));
  const running = sandbox("box-1");
  provider.attach.mockResolvedValue(running);

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await expect(resolveSandbox(1)).resolves.toEqual({
    sandboxId: "box-1",
    host: "https://8787-box-1.sandbox.test",
  });
  expect(provider.attach).toHaveBeenCalledWith("box-1");
  expect(ensureServer).toHaveBeenCalledWith(running, 1, { via: "attach" });
  expect(markAwake).toHaveBeenCalledWith(1, {
    home: "home-alice",
    sandboxId: "box-1",
    host: "https://8787-box-1.sandbox.test",
  });
  expect(provider.wake).not.toHaveBeenCalled();
});

test("a second call within the cache window does not re-check the sandbox", async () => {
  const { getUserById } = await import("./users.js");
  vi.mocked(getUserById).mockResolvedValue(user({ id: 2, sandboxId: "box-1" }));
  provider.attach.mockResolvedValue(sandbox("box-1"));

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await resolveSandbox(2);
  await resolveSandbox(2);
  expect(provider.attach).toHaveBeenCalledOnce();
});

test("a sleeping user is woken from their home, recorded before the server starts, and released once healthy", async () => {
  const { getUserById, claimWake, recordWakingSandbox, markAwake, sandboxOwnerForClerkUser } =
    await import("./users.js");
  const { ensureServer } = await import("./sandbox-wake.js");
  vi.mocked(getUserById).mockResolvedValue(user({ id: 3 }));
  vi.mocked(claimWake).mockResolvedValue(true);
  const woken = sandbox("box-3");
  provider.wake.mockResolvedValue({ home: "home-alice", sandbox: woken, boot: "warm" });

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await expect(resolveSandbox(3)).resolves.toEqual({
    sandboxId: "box-3",
    host: "https://8787-box-3.sandbox.test",
  });
  expect(provider.wake).toHaveBeenCalledWith("home-alice", sandboxOwnerForClerkUser("user_alice"));
  expect(markAwake).toHaveBeenCalledWith(3, {
    home: "home-alice",
    sandboxId: "box-3",
    host: "https://8787-box-3.sandbox.test",
  });
  expect(ensureServer).toHaveBeenCalledWith(woken, 3, {
    via: "wake",
    boot: "warm",
    awakeForMs: provider.maxAwakeMs,
  });
  expect(recordWakingSandbox).toHaveBeenCalledWith(3, {
    home: "home-alice",
    sandboxId: "box-3",
    host: "https://8787-box-3.sandbox.test",
  });
  expect(vi.mocked(recordWakingSandbox).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(ensureServer).mock.invocationCallOrder[0]!,
  );
  expect(vi.mocked(ensureServer).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(markAwake).mock.invocationCallOrder[0]!,
  );
});

test("a sandbox another request is still starting is waited for, not started a second time", async () => {
  const { getUserById, claimWake } = await import("./users.js");
  const { ensureServer } = await import("./sandbox-wake.js");
  vi.mocked(getUserById)
    .mockResolvedValueOnce(user({ id: 19, sandboxId: "box-19", wakeClaimAt: new Date() }))
    .mockResolvedValueOnce(user({ id: 19, sandboxId: "box-19", wakeClaimAt: new Date() }))
    .mockResolvedValue(user({ id: 19, sandboxId: "box-19" }));
  provider.attach.mockResolvedValue(sandbox("box-19"));

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await expect(resolveSandbox(19)).resolves.toMatchObject({ sandboxId: "box-19" });
  expect(provider.attach).toHaveBeenCalledOnce();
  expect(ensureServer).toHaveBeenCalledOnce();
  expect(vi.mocked(getUserById).mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(claimWake).not.toHaveBeenCalled();
});

test("a first-time user's new home is recorded on the account", async () => {
  const { getUserById, claimWake, markAwake } = await import("./users.js");
  vi.mocked(getUserById).mockResolvedValue(user({ id: 8, sandboxHome: null }));
  vi.mocked(claimWake).mockResolvedValue(true);
  provider.wake.mockResolvedValue({ home: "home-new", sandbox: sandbox("box-8"), boot: "cold" });

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await resolveSandbox(8);
  expect(provider.wake).toHaveBeenCalledWith(null, expect.stringMatching(/^gali-user-/));
  expect(markAwake).toHaveBeenCalledWith(8, expect.objectContaining({ home: "home-new" }));
});

test("a failed wake releases the claim so the next request can retry", async () => {
  const { getUserById, claimWake, releaseWakeClaim } = await import("./users.js");
  vi.mocked(getUserById).mockResolvedValue(user({ id: 11 }));
  vi.mocked(claimWake).mockResolvedValue(true);
  provider.wake.mockRejectedValue(new Error("provider down"));

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await expect(resolveSandbox(11)).rejects.toThrow("provider down");
  expect(releaseWakeClaim).toHaveBeenCalledWith(11, null);
});

const startFailed = {
  kind: "start_failed",
  provider: "vercel",
  detail: "sandbox box-x is failed_to_start (internal_error)",
} as const;

test("a provider failure is recorded with the released claim", async () => {
  const { getUserById, claimWake, releaseWakeClaim } = await import("./users.js");
  const { SandboxUnavailableError } = await import("./sandbox-provider/types.js");
  vi.mocked(getUserById).mockResolvedValue(user({ id: 13 }));
  vi.mocked(claimWake).mockResolvedValue(true);
  provider.wake.mockRejectedValue(new SandboxUnavailableError(startFailed));

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await expect(resolveSandbox(13)).rejects.toBeInstanceOf(SandboxUnavailableError);
  expect(releaseWakeClaim).toHaveBeenCalledWith(13, startFailed);
});

test("background traffic reports a fresh failure instead of waking again", async () => {
  const { getUserById, claimWake } = await import("./users.js");
  const { SandboxUnavailableError } = await import("./sandbox-provider/types.js");
  vi.mocked(getUserById).mockResolvedValue(
    user({ id: 14, wakeFailure: startFailed, wakeFailureAt: new Date(Date.now() - 10_000) }),
  );

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  const error = await resolveSandbox(14).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SandboxUnavailableError);
  expect((error as InstanceType<typeof SandboxUnavailableError>).failure).toEqual(startFailed);
  expect(claimWake).not.toHaveBeenCalled();
  expect(provider.wake).not.toHaveBeenCalled();
});

test("an explicit retry wakes a home that just failed", async () => {
  const { getUserById, claimWake } = await import("./users.js");
  vi.mocked(getUserById).mockResolvedValue(
    user({ id: 15, wakeFailure: startFailed, wakeFailureAt: new Date(Date.now() - 10_000) }),
  );
  vi.mocked(claimWake).mockResolvedValue(true);
  provider.wake.mockResolvedValue({ home: "home-alice", sandbox: sandbox("box-15"), boot: "cold" });

  const { retrySandbox } = await import("./sandbox-resolve.js");
  await expect(retrySandbox(15)).resolves.toMatchObject({ sandboxId: "box-15" });
});

test("an old failure no longer blocks background traffic", async () => {
  const { getUserById, claimWake } = await import("./users.js");
  vi.mocked(getUserById).mockResolvedValue(
    user({ id: 16, wakeFailure: startFailed, wakeFailureAt: new Date(Date.now() - 5 * 60_000) }),
  );
  vi.mocked(claimWake).mockResolvedValue(true);
  provider.wake.mockResolvedValue({ home: "home-alice", sandbox: sandbox("box-16"), boot: "cold" });

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await expect(resolveSandbox(16)).resolves.toMatchObject({ sandboxId: "box-16" });
});

test("a request waiting on another wake reports that wake's failure", async () => {
  const { getUserById, claimWake } = await import("./users.js");
  const { SandboxUnavailableError } = await import("./sandbox-provider/types.js");
  vi.mocked(claimWake).mockResolvedValue(false);
  vi.mocked(getUserById)
    .mockResolvedValueOnce(user({ id: 17, wakeClaimAt: new Date() }))
    .mockResolvedValue(user({ id: 17, wakeFailure: startFailed, wakeFailureAt: new Date() }));

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  const error = await resolveSandbox(17).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SandboxUnavailableError);
  expect((error as InstanceType<typeof SandboxUnavailableError>).failure).toEqual(startFailed);
});

test("a request waiting on a wake that never finishes is told the sandbox is busy", async () => {
  vi.useFakeTimers();
  try {
    const { getUserById, claimWake } = await import("./users.js");
    const { SandboxBusyError } = await import("./sandbox-provider/types.js");
    vi.mocked(claimWake).mockResolvedValue(false);
    vi.mocked(getUserById).mockResolvedValue(user({ id: 18, wakeClaimAt: new Date() }));

    const { resolveSandbox } = await import("./sandbox-resolve.js");
    const pending = resolveSandbox(18).catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(SandboxBusyError);
  } finally {
    vi.useRealTimers();
  }
});

test("losing the wake claim waits for the winner instead of waking twice", async () => {
  const { getUserById, claimWake } = await import("./users.js");
  vi.mocked(claimWake).mockResolvedValue(false);
  vi.mocked(getUserById)
    .mockResolvedValueOnce(user({ id: 4, wakeClaimAt: new Date() }))
    .mockResolvedValue(user({ id: 4, sandboxId: "box-winner" }));
  provider.attach.mockResolvedValue(sandbox("box-winner"));

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  const resolved = await resolveSandbox(4);
  expect(resolved.sandboxId).toBe("box-winner");
  expect(provider.wake).not.toHaveBeenCalled();
});

test("a sandbox that is no longer running is treated as asleep and re-woken", async () => {
  const { getUserById, claimWake, markAsleep } = await import("./users.js");
  vi.mocked(getUserById).mockResolvedValue(user({ id: 5, sandboxId: "box-gone" }));
  provider.attach.mockResolvedValue(null);
  vi.mocked(claimWake).mockResolvedValue(true);
  provider.wake.mockResolvedValue({ home: "home-alice", sandbox: sandbox("box-fresh"), boot: "cold" });

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  const resolved = await resolveSandbox(5);
  expect(markAsleep).toHaveBeenCalledWith(5);
  expect(resolved.sandboxId).toBe("box-fresh");
});

test("an awake sandbox without a home is a corrupt account, not a fresh start", async () => {
  const { getUserById } = await import("./users.js");
  vi.mocked(getUserById).mockResolvedValue(user({ id: 6, sandboxId: "box-6", sandboxHome: null }));

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await expect(resolveSandbox(6)).rejects.toThrow(/has sandbox box-6 but no home/);
  expect(provider.wake).not.toHaveBeenCalled();
});

test("an account on a provider the config no longer selects starts over on the configured one", async () => {
  const { getUserById, claimWake, moveToProvider } = await import("./users.js");
  vi.mocked(getUserById)
    .mockResolvedValueOnce(user({ id: 12, sandboxProvider: "e2b" as User["sandboxProvider"], sandboxHome: "gali-user-old", sandboxId: "old-box" }))
    .mockResolvedValue(user({ id: 12, sandboxHome: null }));
  vi.mocked(claimWake).mockResolvedValue(true);
  provider.wake.mockResolvedValue({ home: "home-new", sandbox: sandbox("box-12"), boot: "cold" });

  const { routeSandbox } = await import("./sandbox-resolve.js");
  await expect(routeSandbox(12)).resolves.toEqual({
    sandboxId: "box-12",
    host: "https://8787-box-12.sandbox.test",
  });
  expect(moveToProvider).toHaveBeenCalledWith(12, "e2b", "vercel");
  expect(provider.attach).not.toHaveBeenCalled();
  expect(provider.wake).toHaveBeenCalledWith(null, expect.stringMatching(/^gali-user-/));
});

test("an unknown account fails loudly, not silently", async () => {
  const { getUserById } = await import("./users.js");
  vi.mocked(getUserById).mockResolvedValue(null);

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  await expect(resolveSandbox(999)).rejects.toThrow(/no account for userId 999/);
});

test("a server that never turns healthy is a recorded server_failed failure, with its log sent to ours", async () => {
  const { getUserById, claimWake, releaseWakeClaim } = await import("./users.js");
  const { ensureServer, GaliServerError } = await import("./sandbox-wake.js");
  const { SandboxUnavailableError } = await import("./sandbox-provider/types.js");
  vi.mocked(getUserById).mockResolvedValue(user({ id: 31 }));
  vi.mocked(claimWake).mockResolvedValue(true);
  provider.wake.mockResolvedValue({ home: "home-alice", sandbox: sandbox("box-31"), boot: "cold" });
  vi.mocked(ensureServer).mockRejectedValueOnce(new GaliServerError("never became healthy: 502 bad gateway"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  const { resolveSandbox } = await import("./sandbox-resolve.js");
  const failure = await resolveSandbox(31).catch((error: unknown) => error);

  const expected = { kind: "server_failed", provider: "vercel", detail: "never became healthy: 502 bad gateway" };
  expect(failure).toBeInstanceOf(SandboxUnavailableError);
  expect(failure).toMatchObject({ failure: expected });
  expect(releaseWakeClaim).toHaveBeenCalledWith(31, expected);
  expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
    expect.objectContaining({ eventName: "sandbox.process.crashed", sandboxId: "box-31", userId: 31 }),
  ]);
  expect(JSON.stringify(logged.mock.calls)).toContain("PGlite lock held");
  logged.mockRestore();
});
