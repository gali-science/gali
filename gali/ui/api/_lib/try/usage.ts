import { and, eq, inArray, isNull, sql, TransactionRollbackError } from "drizzle-orm";
import { db } from "../db/client.js";
import { trySpend, tryUsage, tryVoiceCalls } from "../db/schema.js";

export type Spend = { key: string; micros: number; capMicros: number };

export type VoiceCall = {
  callId: string;
  day: string;
  startedAt: Date;
  personKey: string | null;
  ipKey: string | null;
  paidSeconds: number | null;
};

const callColumns = {
  callId: tryVoiceCalls.callId,
  day: tryVoiceCalls.day,
  startedAt: tryVoiceCalls.startedAt,
  personKey: tryVoiceCalls.personKey,
  ipKey: tryVoiceCalls.ipKey,
  paidSeconds: tryVoiceCalls.paidSeconds,
};

export function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

async function addSpends(tx: Tx, spends: Spend[]): Promise<void> {
  for (const { key, micros, capMicros } of spends) {
    const spent = await tx
      .insert(trySpend)
      .values({ key, spentMicros: micros })
      .onConflictDoUpdate({
        target: trySpend.key,
        set: { spentMicros: sql`${trySpend.spentMicros} + ${micros}` },
        setWhere: sql`${trySpend.spentMicros} + ${micros} <= ${capMicros}`,
      })
      .returning({ key: trySpend.key });
    if (spent.length === 0) tx.rollback();
  }
}

async function allOrNothing(run: (tx: Tx) => Promise<void>): Promise<boolean> {
  try {
    await db().transaction(run);
    return true;
  } catch (error) {
    if (error instanceof TransactionRollbackError) return false;
    throw error;
  }
}

export async function spend(
  day: string,
  counter: "voiceSeconds" | "answers",
  amount: number,
  cap: number,
  spends: Spend[],
): Promise<boolean> {
  if (amount > cap || spends.some((row) => row.micros > row.capMicros)) return false;
  const column = tryUsage[counter];
  return allOrNothing(async (tx) => {
    const counted = await tx
      .insert(tryUsage)
      .values(counter === "voiceSeconds" ? { day, voiceSeconds: amount } : { day, answers: amount })
      .onConflictDoUpdate({
        target: tryUsage.day,
        set: counter === "voiceSeconds" ? { voiceSeconds: sql`${column} + ${amount}` } : { answers: sql`${column} + ${amount}` },
        setWhere: sql`${column} + ${amount} <= ${cap}`,
      })
      .returning({ day: tryUsage.day });
    if (counted.length === 0) tx.rollback();
    await addSpends(tx, spends);
  });
}

export async function takeCallSlots(slots: Spend[]): Promise<boolean> {
  if (slots.some((slot) => slot.micros > slot.capMicros)) return false;
  return allOrNothing((tx) => addSpends(tx, slots));
}

export async function refundVoice(day: string, seconds: number, micros: number, keys: string[]): Promise<void> {
  if (seconds === 0) return;
  await db().transaction(async (tx) => {
    await tx
      .update(tryUsage)
      .set({ voiceSeconds: sql`${tryUsage.voiceSeconds} - ${seconds}` })
      .where(eq(tryUsage.day, day));
    if (keys.length > 0) {
      await tx
        .update(trySpend)
        .set({ spentMicros: sql`${trySpend.spentMicros} - ${micros}` })
        .where(inArray(trySpend.key, keys));
    }
  });
}

export async function releaseCallSlots(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await db()
    .update(trySpend)
    .set({ spentMicros: sql`greatest(${trySpend.spentMicros} - 1, 0)` })
    .where(inArray(trySpend.key, keys));
}

export async function openVoiceCallsOf(personKey: string): Promise<string[]> {
  const rows = await db()
    .select({ callId: tryVoiceCalls.callId })
    .from(tryVoiceCalls)
    .where(and(eq(tryVoiceCalls.personKey, personKey), isNull(tryVoiceCalls.endedAt)));
  return rows.map((row) => row.callId);
}

export async function openVoiceCall(call: Omit<VoiceCall, "paidSeconds"> & { paidSeconds: number }): Promise<void> {
  await db().insert(tryVoiceCalls).values(call);
}

export async function findOpenVoiceCall(callId: string): Promise<VoiceCall | null> {
  const [call] = await db()
    .select(callColumns)
    .from(tryVoiceCalls)
    .where(and(eq(tryVoiceCalls.callId, callId), isNull(tryVoiceCalls.endedAt)));
  return call ?? null;
}

export async function payVoiceCall(callId: string, fromSeconds: number, toSeconds: number): Promise<boolean> {
  const rows = await db()
    .update(tryVoiceCalls)
    .set({ paidSeconds: toSeconds })
    .where(and(
      eq(tryVoiceCalls.callId, callId),
      isNull(tryVoiceCalls.endedAt),
      eq(tryVoiceCalls.paidSeconds, fromSeconds),
    ))
    .returning({ callId: tryVoiceCalls.callId });
  return rows.length > 0;
}

export async function closeVoiceCall(callId: string, endedAt: Date): Promise<VoiceCall | null> {
  const [call] = await db()
    .update(tryVoiceCalls)
    .set({ endedAt })
    .where(and(eq(tryVoiceCalls.callId, callId), isNull(tryVoiceCalls.endedAt)))
    .returning(callColumns);
  return call ?? null;
}

export async function overdueVoiceCalls(now: Date, graceSeconds: number, limit: number): Promise<string[]> {
  const rows = await db()
    .select({ callId: tryVoiceCalls.callId })
    .from(tryVoiceCalls)
    .where(and(
      isNull(tryVoiceCalls.endedAt),
      sql`${tryVoiceCalls.startedAt} + make_interval(secs => coalesce(${tryVoiceCalls.paidSeconds}, 3600) + ${graceSeconds}) < ${now.toISOString()}::timestamptz`,
    ))
    .limit(limit);
  return rows.map((row) => row.callId);
}
