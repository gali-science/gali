import { beforeEach, expect, test, vi } from "vitest";
import { GALI_CONFIG } from "../../shared/config.js";

const getSession = vi.fn();
const recordUsage = vi.fn();

vi.mock("./_lib/auth.js", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}));

vi.mock("./_lib/trial.js", () => ({
  trialStatus: vi.fn(),
  recordUsageWithRetry: (...args: unknown[]) => recordUsage(...args),
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

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset();
  recordUsage.mockReset();
});

test("rejects unauthenticated usage reports", async () => {
  getSession.mockResolvedValue(null);
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    { method: "POST", query: { op: "usage" }, body: {} } as never,
    res as never,
  );
  expect(res.statusCode).toBe(401);
  expect(recordUsage).not.toHaveBeenCalled();
});

test("prices realtime reports with the server model", async () => {
  getSession.mockResolvedValue({ userId: 3, clerkUserId: "user_3" });
  const trial = {
    status: "exhausted",
    spentUsd: 10.1,
    budgetUsd: 10,
    remainingUsd: 0,
  };
  recordUsage.mockResolvedValue(trial);
  const usage = { input_tokens: 10, output_tokens: 5 };
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    {
      method: "POST",
      query: { op: "usage" },
      body: {
        kind: "response",
        externalId: "resp_1",
        model: "cheap-client-model",
        usage,
      },
    } as never,
    res as never,
  );
  expect(recordUsage).toHaveBeenCalledWith({
    userId: 3,
    source: "realtime",
    externalId: "resp_1",
    model: GALI_CONFIG.realtime.model,
    usage,
  });
  expect(res.body).toEqual({ trial });
});

test("prices transcription reports with the server model", async () => {
  getSession.mockResolvedValue({ userId: 3, clerkUserId: "user_3" });
  recordUsage.mockResolvedValue({
    status: "active",
    spentUsd: 1,
    budgetUsd: 10,
    remainingUsd: 9,
  });
  const usage = { type: "duration", seconds: 2 };
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    {
      method: "POST",
      query: { op: "usage" },
      body: { kind: "transcription", externalId: "item_1", usage },
    } as never,
    res as never,
  );
  expect(recordUsage).toHaveBeenCalledWith({
    userId: 3,
    source: "transcription",
    externalId: "item_1",
    model: GALI_CONFIG.realtime.transcribeModel,
    usage,
  });
  expect(res.statusCode).toBe(200);
});
