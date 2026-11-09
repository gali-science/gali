import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const missingPrices = vi.fn<() => string[]>(() => []);

vi.mock("./_lib/pricing.js", () => ({ pricingHealth: () => ({ missing: missingPrices() }) }));
vi.mock("./_lib/auth.js", () => ({}));
vi.mock("./_lib/memory-summarize.js", () => ({}));
vi.mock("./_lib/trial.js", () => ({}));
vi.mock("./_lib/users.js", () => ({}));
vi.mock("./_lib/voice-memory.js", () => ({}));

const { default: handler } = await import("./account.js");

async function health() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader() {},
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(value: unknown) {
      res.body = value;
      return res;
    },
  };
  await handler(
    { query: { op: "health" }, headers: {}, method: "GET" } as unknown as VercelRequest,
    res as unknown as VercelResponse,
  );
  return res;
}

const saved = { ...process.env };
let logged: string[];

beforeEach(() => {
  process.env.TOGETHER_API_KEY = "together-test";
  process.env.GALI_SANDBOX_HTTP_MASTER_KEY = "master-test";
  missingPrices.mockReturnValue([]);
  logged = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    logged.push(line);
  });
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

test("health says only ok when everything is configured", async () => {
  const res = await health();
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ ok: true });
  expect(logged).toEqual([]);
});

test("health hides which setting is missing and logs it instead", async () => {
  delete process.env.GALI_SANDBOX_HTTP_MASTER_KEY;
  missingPrices.mockReturnValue(["gpt-realtime-9.input"]);
  const res = await health();
  expect(res.statusCode).toBe(503);
  expect(res.body).toEqual({ ok: false });
  expect(logged).toHaveLength(1);
  expect(JSON.parse(logged[0]!)).toMatchObject({
    eventName: "control.misconfigured",
    errorMessage: "missing: GALI_SANDBOX_HTTP_MASTER_KEY, price gpt-realtime-9.input",
  });
});
