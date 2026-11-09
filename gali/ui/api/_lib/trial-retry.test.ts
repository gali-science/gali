import { expect, test, vi } from "vitest";

const externalIds: string[] = [];
let attempts = 0;

const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
  attempts += 1;
  const tx = {
    insert: () => ({
      values: (value: { externalId: string }) => {
        externalIds.push(value.externalId);
        return {
          onConflictDoNothing: () => ({
            returning: async () => [{ id: 1 }],
          }),
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => [{ id: 7, trialSpentMicros: 1 }],
        }),
      }),
    }),
  };
  const result = await callback(tx);
  if (attempts === 1) throw new Error("connection dropped after commit");
  return result;
});

vi.mock("./db/client.js", () => ({
  db: () => ({ transaction }),
}));

vi.mock("./pricing.js", () => ({
  priceUsage: () => 1,
}));

test("uses one idempotency ID across an ambiguous retry", async () => {
  const { recordUsageWithRetry } = await import("./trial.js");
  await expect(
    recordUsageWithRetry({
      userId: 7,
      source: "responses",
      model: "gpt-6-luna",
      usage: { input_tokens: 1 },
    }),
  ).resolves.toMatchObject({ status: "active" });
  expect(externalIds).toHaveLength(2);
  expect(externalIds[0]).toBe(externalIds[1]);
});
