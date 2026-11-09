import { beforeEach, expect, test, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  const values: Record<string, string> = {};
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
      removeItem: (key: string) => {
        delete values[key];
      },
      clear: () => {
        for (const key of Object.keys(values)) delete values[key];
      },
    },
  });
});

test("keeps a failed voice usage report and retries it", async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetchMock);
  const {
    flushTrialUsageQueue,
    reportTrialUsage,
    setTrialUsageScope,
  } = await import("./account");
  setTrialUsageScope("user-a@example.com");
  const report = {
    kind: "response" as const,
    externalId: "resp_1",
    usage: { input_tokens: 10, output_tokens: 2 },
  };

  await expect(reportTrialUsage(report)).rejects.toThrow("offline");
  expect(localStorage.getItem("gali.trial.usage:user-a@example.com")).toContain("resp_1");

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({
      trial: { status: "active", spentUsd: 1, budgetUsd: 10, remainingUsd: 9 },
    }), { status: 200 }),
  );
  await expect(flushTrialUsageQueue()).resolves.toMatchObject({
    status: "active",
  });
  expect(localStorage.getItem("gali.trial.usage:user-a@example.com")).toBeNull();
  vi.unstubAllGlobals();
});

test("does not queue the same OpenAI event twice", async () => {
  let release!: () => void;
  const fetchMock = vi.fn().mockImplementation(
    () => new Promise<Response>((resolve) => {
      release = () => resolve(
        new Response(JSON.stringify({
          trial: { status: "active", spentUsd: 1, budgetUsd: 10, remainingUsd: 9 },
        }), { status: 200 }),
      );
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const { reportTrialUsage, setTrialUsageScope } = await import("./account");
  setTrialUsageScope("user-a@example.com");
  const report = {
    kind: "transcription" as const,
    externalId: "item_1",
    usage: { type: "duration", seconds: 2 },
  };

  const first = reportTrialUsage(report);
  const second = reportTrialUsage(report);
  release();
  await Promise.all([first, second]);
  expect(fetchMock).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

test("does not send one user's queued usage under another account", async () => {
  const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
  vi.stubGlobal("fetch", fetchMock);
  const {
    flushTrialUsageQueue,
    reportTrialUsage,
    setTrialUsageScope,
  } = await import("./account");
  setTrialUsageScope("user-a@example.com");
  await reportTrialUsage({
    kind: "response",
    externalId: "resp_a",
    usage: { input_tokens: 10 },
  }).catch(() => {});

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({
      trial: { status: "active", spentUsd: 0, budgetUsd: 10, remainingUsd: 10 },
    }), { status: 200 }),
  );
  setTrialUsageScope("user-b@example.com");
  await flushTrialUsageQueue();
  expect(fetchMock).not.toHaveBeenCalled();

  setTrialUsageScope("user-a@example.com");
  await flushTrialUsageQueue();
  expect(fetchMock).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});

test("aborts an in-flight retry when the account changes", async () => {
  const account = await import("./account");
  account.setTrialUsageScope("user-a@example.com");
  const fetchMock = vi.fn().mockImplementation(async () => {
    account.setTrialUsageScope("user-b@example.com");
    throw new Error("offline");
  });
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    account.reportTrialUsage({
      kind: "response",
      externalId: "resp_switch",
      usage: { input_tokens: 10 },
    }),
  ).resolves.toBeNull();
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(localStorage.getItem("gali.trial.usage:user-a@example.com")).toContain("resp_switch");
  vi.unstubAllGlobals();
});
