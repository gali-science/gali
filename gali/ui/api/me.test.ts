import { beforeEach, expect, test, vi } from "vitest";
import { GALI_CONFIG } from "../../shared/config.js";

const getSession = vi.fn();
const getUserById = vi.fn();
const acceptModelConsentById = vi.fn();

vi.mock("./_lib/auth.js", () => ({
  getSession: (...args: unknown[]) => getSession(...args),
}));

vi.mock("./_lib/users.js", () => ({
  MODEL_CONSENT_VERSION: 1,
  hasCurrentModelConsent: (user: {
    consentVersion?: number | null;
    voiceOpenAiAccepted?: boolean;
    experimentsTogetherAccepted?: boolean;
  }) =>
    user.consentVersion === 1
    && user.voiceOpenAiAccepted === true
    && user.experimentsTogetherAccepted === true,
  getUserById: (...args: unknown[]) => getUserById(...args),
  acceptModelConsentById: (...args: unknown[]) => acceptModelConsentById(...args),
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
  getUserById.mockReset();
  acceptModelConsentById.mockReset();
  getSession.mockResolvedValue(null);
});

test("consent blocks until both model disclosures are accepted", async () => {
  getSession.mockResolvedValue({ userId: 3, clerkUserId: "user_3" });
  getUserById.mockResolvedValue({
    id: 3,
    consentVersion: null,
    voiceOpenAiAccepted: false,
    experimentsTogetherAccepted: false,
    consentAcceptedAt: null,
  });
  const { default: account } = await import("./account.js");
  const before = mockRes();
  await account(
    { method: "GET", headers: {}, query: { op: "consent" } } as never,
    before as never,
  );
  expect(before.body).toMatchObject({ version: 1, accepted: false });

  const acceptedAt = new Date();
  acceptModelConsentById.mockResolvedValue({
    id: 3,
    consentVersion: 1,
    voiceOpenAiAccepted: true,
    experimentsTogetherAccepted: true,
    consentAcceptedAt: acceptedAt,
  });
  const after = mockRes();
  await account(
    {
      method: "POST",
      headers: {},
      query: { op: "consent" },
      body: {
        voiceOpenAiAccepted: true,
        experimentsTogetherAccepted: true,
      },
    } as never,
    after as never,
  );
  expect(acceptModelConsentById).toHaveBeenCalledWith(3, 1);
  expect(after.body).toMatchObject({
    version: 1,
    accepted: true,
    acceptedAt: acceptedAt.toISOString(),
  });
});

test("a browser error is logged to Vercel under the signed-in user", async () => {
  getSession.mockResolvedValue({ userId: 3, clerkUserId: "user_3" });
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    {
      method: "POST",
      headers: {},
      query: { op: "client-error" },
      body: {
        errorCode: "pdf_engine_failed",
        errorMessage: "TypeError: Failed to fetch https://cdn.example/pdfium.wasm?token=abc",
        userId: 99,
      },
    } as never,
    res as never,
  );
  expect(res.statusCode).toBe(202);
  expect(JSON.parse(String(logged.mock.calls[0]![0]))).toMatchObject({
    eventName: "client.failed",
    level: "error",
    source: "browser",
    userId: 3,
    errorCode: "pdf_engine_failed",
    errorMessage: "TypeError: Failed to fetch https://cdn.example/pdfium.wasm?[REDACTED]",
  });
  logged.mockRestore();
});

test("a browser stream gap is logged with its phase and downtime", async () => {
  getSession.mockResolvedValue({ userId: 3, clerkUserId: "user_3" });
  const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    {
      method: "POST",
      headers: {},
      query: { op: "client-event" },
      body: { eventName: "client.stream.gap", phase: "backend-restarted", durationMs: 4200, status: "cursor 9 > latest 2" },
    } as never,
    res as never,
  );
  expect(res.statusCode).toBe(202);
  expect(JSON.parse(String(logged.mock.calls[0]![0]))).toMatchObject({
    eventName: "client.stream.gap",
    level: "warn",
    source: "browser",
    userId: 3,
    phase: "backend-restarted",
    durationMs: 4200,
  });
  logged.mockRestore();
});

test("browser events outside the allowlist are rejected", async () => {
  getSession.mockResolvedValue({ userId: 3, clerkUserId: "user_3" });
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    {
      method: "POST",
      headers: {},
      query: { op: "client-event" },
      body: { eventName: "sandbox.wake.completed" },
    } as never,
    res as never,
  );
  expect(res.statusCode).toBe(400);
});

test("browser errors from signed-out visitors are rejected", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    {
      method: "POST",
      headers: {},
      query: { op: "client-error" },
      body: { errorCode: "pdf_engine_failed", errorMessage: "boom" },
    } as never,
    res as never,
  );
  expect(res.statusCode).toBe(401);
  expect(logged).not.toHaveBeenCalled();
  logged.mockRestore();
});

test("unauthenticated requests are rejected", async () => {
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account({ method: "GET", headers: {}, query: { op: "me" } } as never, res as never);
  expect(res.statusCode).toBe(401);
});

test("GET returns Clerk identity and trial", async () => {
  getSession.mockResolvedValue({ userId: 3, clerkUserId: "user_3" });
  getUserById.mockResolvedValue({
    id: 3,
    displayName: "Alice",
    identityEmail: "alice@example.com",
    trialSpentMicros: 0,
  });
  const { default: account } = await import("./account.js");
  const res = mockRes();
  await account(
    { method: "GET", headers: {}, query: { op: "me" } } as never,
    res as never,
  );
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({
    displayName: "Alice",
    identityEmail: "alice@example.com",
    trial: {
      status: "active",
      spentUsd: 0,
      budgetUsd: GALI_CONFIG.trialBudgetUsd,
      remainingUsd: GALI_CONFIG.trialBudgetUsd,
    },
  });
});
