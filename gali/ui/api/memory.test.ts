import { beforeEach, expect, test, vi } from "vitest";

const getSession = vi.fn();
const getUserById = vi.fn();
const getVoiceMemoryRow = vi.fn();
const saveVoiceMemoryInput = vi.fn();
const saveVoiceMemorySummary = vi.fn();
const summarizeTranscript = vi.fn();
const recordUsage = vi.fn();
const trialStatus = vi.fn();

vi.mock("./_lib/auth.js", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}));

vi.mock("./_lib/users.js", () => ({
  getUserById: (...args: unknown[]) => getUserById(...args),
}));

vi.mock("./_lib/trial.js", () => ({
  trialStatus: (...args: unknown[]) => trialStatus(...args),
  recordUsageWithRetry: (...args: unknown[]) => recordUsage(...args),
}));

vi.mock("./_lib/voice-memory.js", () => ({
  getVoiceMemoryRow: (...args: unknown[]) => getVoiceMemoryRow(...args),
  saveVoiceMemoryInput: (...args: unknown[]) => saveVoiceMemoryInput(...args),
  saveVoiceMemorySummary: (...args: unknown[]) => saveVoiceMemorySummary(...args),
}));

vi.mock("./_lib/memory-summarize.js", () => ({
  summarizeTranscript: (...args: unknown[]) => summarizeTranscript(...args),
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

function cookieFor(userId: number): string {
  getSession.mockResolvedValue({ userId, clerkUserId: `user_${userId}` });
  return "__session=test";
}

beforeEach(() => {
  vi.resetModules();
  getSession.mockReset();
  getUserById.mockReset();
  getVoiceMemoryRow.mockReset();
  saveVoiceMemoryInput.mockReset();
  saveVoiceMemorySummary.mockReset();
  summarizeTranscript.mockReset();
  recordUsage.mockReset();
  trialStatus.mockReset();
  getSession.mockResolvedValue(null);
  getUserById.mockResolvedValue({ id: 3, trialSpentMicros: 0 });
  trialStatus.mockReturnValue({
    status: "active",
    spentUsd: 0,
    budgetUsd: 10,
    remainingUsd: 10,
  });
});

test("unauthenticated memory requests are rejected", async () => {
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account({ method: "GET", headers: {}, query: { op: "memory" } } as never, res as never);
  expect(res.statusCode).toBe(401);
});

test("GET with no stored row returns null", async () => {
  getVoiceMemoryRow.mockResolvedValue(null);
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    { method: "GET", headers: { cookie: cookieFor(3) }, query: { op: "memory" } } as never,
    res as never,
  );
  expect(res.statusCode).toBe(200);
  expect(res.body).toBeNull();
  expect(summarizeTranscript).not.toHaveBeenCalled();
});

test("GET with a fresh summary skips the model", async () => {
  const transcriptAt = new Date("2026-08-11T20:00:00Z");
  getVoiceMemoryRow.mockResolvedValue({
    userId: 3,
    summary: "worked on Demo (key: demo)",
    transcript: "User: hi",
    uiLocation: "on the Home screen",
    transcriptAt,
    summarizedAt: new Date("2026-08-11T20:05:00Z"),
    updatedAt: new Date("2026-08-11T20:05:00Z"),
  });
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    { method: "GET", headers: { cookie: cookieFor(3) }, query: { op: "memory" } } as never,
    res as never,
  );
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({
    summary: "worked on Demo (key: demo)",
    uiLocation: "on the Home screen",
    endedAt: transcriptAt.toISOString(),
  });
  expect(summarizeTranscript).not.toHaveBeenCalled();
});

test("GET with a stale transcript returns it immediately and summarizes in the background", async () => {
  const transcriptAt = new Date("2026-08-11T21:00:00Z");
  getVoiceMemoryRow.mockResolvedValue({
    userId: 3,
    summary: "old note",
    transcript: "User: closed experiment 12",
    uiLocation: "",
    transcriptAt,
    summarizedAt: new Date("2026-08-11T20:00:00Z"),
    updatedAt: transcriptAt,
  });
  summarizeTranscript.mockResolvedValue({
    summary: "closed experiment 12 in Demo (key: demo)",
    model: "gpt-5.6-luna",
    responseId: "resp_memory",
    usage: { input_tokens: 20, output_tokens: 5 },
  });
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    { method: "GET", headers: { cookie: cookieFor(3) }, query: { op: "memory" } } as never,
    res as never,
  );
  expect(res.body).toMatchObject({
    summary: "User: closed experiment 12",
    endedAt: transcriptAt.toISOString(),
  });
  await vi.waitFor(() => {
    expect(summarizeTranscript).toHaveBeenCalledWith({
      transcript: "User: closed experiment 12",
      previousSummary: "old note",
    });
    expect(saveVoiceMemorySummary).toHaveBeenCalledWith(
      3,
      "closed experiment 12 in Demo (key: demo)",
      transcriptAt,
    );
    expect(recordUsage).toHaveBeenCalledWith({
      userId: 3,
      source: "memory",
      externalId: "resp_memory",
      model: "gpt-5.6-luna",
      usage: { input_tokens: 20, output_tokens: 5 },
    });
  });
});

test("GET with an empty summary still returns the transcript when the model fails", async () => {
  const transcriptAt = new Date("2026-08-11T21:00:00Z");
  getVoiceMemoryRow.mockResolvedValue({
    userId: 3,
    summary: "",
    transcript: "User: what about last time\nGali: we started experiment 2",
    uiLocation: "",
    transcriptAt,
    summarizedAt: null,
    updatedAt: transcriptAt,
  });
  summarizeTranscript.mockRejectedValue(new Error("model down"));
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    { method: "GET", headers: { cookie: cookieFor(3) }, query: { op: "memory" } } as never,
    res as never,
  );
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({
    summary: "User: what about last time\nGali: we started experiment 2",
  });
  await vi.waitFor(() => {
    expect(summarizeTranscript).toHaveBeenCalled();
  });
  expect(saveVoiceMemorySummary).not.toHaveBeenCalled();
});

test("GET keeps summarizing after the trial is spent", async () => {
  const transcriptAt = new Date("2026-08-11T21:00:00Z");
  trialStatus.mockReturnValue({
    status: "exhausted",
    spentUsd: 10,
    budgetUsd: 10,
    remainingUsd: 0,
  });
  getVoiceMemoryRow.mockResolvedValue({
    userId: 3,
    summary: "old note",
    transcript: "User: new work",
    uiLocation: "",
    transcriptAt,
    summarizedAt: null,
    updatedAt: transcriptAt,
  });
  summarizeTranscript.mockResolvedValue({ summary: "new work" });
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    { method: "GET", headers: { cookie: cookieFor(3) }, query: { op: "memory" } } as never,
    res as never,
  );
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ summary: "User: new work" });
  await vi.waitFor(() => {
    expect(saveVoiceMemorySummary).toHaveBeenCalledWith(3, "new work", transcriptAt);
  });
});

test("POST saves the transcript for the session user", async () => {
  saveVoiceMemoryInput.mockResolvedValue(undefined);
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    {
      method: "POST",
      headers: { cookie: cookieFor(7) },
      query: { op: "memory" },
      body: { transcript: "User: hello\nGali: hi" },
    } as never,
    res as never,
  );
  expect(saveVoiceMemoryInput).toHaveBeenCalledWith(7, {
    transcript: "User: hello\nGali: hi",
    uiLocation: undefined,
  });
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ ok: true });
});

test("POST rejects non-string fields and empty bodies", async () => {
  const { default: account } = await import("./account.js");
  const bad = mockRes();
  await account(
    {
      method: "POST",
      headers: { cookie: cookieFor(7) },
      query: { op: "memory" },
      body: { transcript: 42 },
    } as never,
    bad as never,
  );
  expect(bad.statusCode).toBe(400);

  const empty = mockRes();
  await account(
    {
      method: "POST",
      headers: { cookie: cookieFor(7) },
      query: { op: "memory" },
      body: {},
    } as never,
    empty as never,
  );
  expect(empty.statusCode).toBe(400);
  expect(saveVoiceMemoryInput).not.toHaveBeenCalled();
});
