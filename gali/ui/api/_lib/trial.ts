import crypto from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { GALI_CONFIG } from "../../../shared/config.js";
import { db } from "./db/client.js";
import {
  usageEvents,
  users,
  type User,
} from "./db/schema.js";
import { priceUsage, type UsageRecord } from "./pricing.js";

export type TrialStatus = {
  status: "active" | "exhausted";
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
};

export type UsageSource =
  | "responses"
  | "realtime"
  | "transcription"
  | "memory";

export function trialBudgetMicros(): number {
  return Math.round(GALI_CONFIG.trialBudgetUsd * 1_000_000);
}

export function trialStatus(user: Pick<User, "trialSpentMicros">): TrialStatus {
  const budgetMicros = trialBudgetMicros();
  const spentMicros = Number.isFinite(user.trialSpentMicros)
    ? Math.max(0, user.trialSpentMicros)
    : 0;
  return {
    status: spentMicros >= budgetMicros ? "exhausted" : "active",
    spentUsd: spentMicros / 1_000_000,
    budgetUsd: budgetMicros / 1_000_000,
    remainingUsd: Math.max(0, budgetMicros - spentMicros) / 1_000_000,
  };
}

export async function recordUsage(input: {
  userId: number;
  source: UsageSource;
  externalId?: string;
  model: string;
  usage: UsageRecord;
  costMicrosOverride?: number;
}): Promise<TrialStatus> {
  const costMicros = input.costMicrosOverride === undefined
    ? priceUsage(input.model, input.usage, input.source)
    : input.costMicrosOverride;
  if (!Number.isSafeInteger(costMicros) || costMicros < 0) {
    throw new Error("costMicrosOverride must be a non-negative safe integer");
  }
  const externalId = input.externalId?.trim() || crypto.randomUUID();
  const user = await db().transaction(async (tx) => {
    const inserted = await tx
      .insert(usageEvents)
      .values({
        userId: input.userId,
        source: input.source,
        externalId,
        model: input.model,
        usage: input.usage,
        costMicros,
      })
      .onConflictDoNothing()
      .returning({ id: usageEvents.id });
    if (inserted.length > 0) {
      const updated = await tx
        .update(users)
        .set({
          trialSpentMicros: sql`${users.trialSpentMicros} + ${costMicros}`,
        })
        .where(eq(users.id, input.userId))
        .returning();
      const row = updated[0];
      if (!row) throw new Error(`recordUsage: no user id ${input.userId}`);
      return row;
    }
    const current = await tx.select().from(users).where(eq(users.id, input.userId)).limit(1);
    const row = current[0];
    if (!row) throw new Error(`recordUsage: no user id ${input.userId}`);
    return row;
  });
  return trialStatus(user);
}

export async function recordUsageWithRetry(
  input: Parameters<typeof recordUsage>[0],
): Promise<TrialStatus> {
  const stableInput = {
    ...input,
    externalId: input.externalId?.trim() || crypto.randomUUID(),
  };
  const waits = [0, 100, 500];
  let failure: unknown;
  for (const wait of waits) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await recordUsage(stableInput);
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
