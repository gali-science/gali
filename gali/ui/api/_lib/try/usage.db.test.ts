// @vitest-environment node
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, test, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../db/client.js", () => ({ db: () => holder.db }));

const usage = await import("./usage.js");
const day = "2026-10-30";
let client: PGlite;

beforeEach(async () => {
  client = new PGlite();
  holder.db = drizzle(client);
  await migrate(holder.db as ReturnType<typeof drizzle>, { migrationsFolder: fileURLToPath(new URL("../../../drizzle", import.meta.url)) });
});

async function spent(key: string): Promise<number | undefined> {
  return (await client.query<{ spent_micros: number }>("select spent_micros from try_spend where key = $1", [key])).rows[0]?.spent_micros;
}

async function plan(query: string): Promise<string> {
  return (await client.query<{ "QUERY PLAN": string }>(`explain ${query}`)).rows.map((row) => row["QUERY PLAN"]).join("\n");
}

test("a charge is all or nothing, and parallel charges never pass a cap", async () => {
  const money = (micros: number) => [
    { key: "person:a", micros, capMicros: 10_000_000 },
    { key: `ip:${day}:x`, micros, capMicros: 100_000_000 },
  ];
  const results = await Promise.all(Array.from({ length: 12 }, () => usage.spend(day, "voiceSeconds", 300, 150_000, money(1_000_000))));

  expect(results.filter(Boolean)).toHaveLength(10);
  expect(await spent("person:a")).toBe(10_000_000);
  expect(await spent(`ip:${day}:x`)).toBe(10_000_000);
  expect((await client.query("select voice_seconds from try_usage")).rows).toEqual([{ voice_seconds: 3000 }]);
});

test("a network gets at most 10 call places at once, and a freed place never goes below zero", async () => {
  const slots = (n: number) => [
    { key: `calls:${day}:person:${n}`, micros: 1, capMicros: 1 },
    { key: `calls:${day}:ip:x`, micros: 1, capMicros: 10 },
  ];
  const taken = await Promise.all(Array.from({ length: 11 }, (_, n) => usage.takeCallSlots(slots(n))));
  expect(taken.filter(Boolean)).toHaveLength(10);
  expect(await spent(`calls:${day}:ip:x`)).toBe(10);

  await usage.releaseCallSlots([`calls:${day}:person:0`, `calls:${day}:ip:x`]);
  await usage.releaseCallSlots([`calls:${day}:person:0`]);
  expect(await spent(`calls:${day}:person:0`)).toBe(0);
  expect(await spent(`calls:${day}:ip:x`)).toBe(9);
});

test("finding open calls reads only the open-call index, however many calls have ended", async () => {
  await client.exec(`
    insert into try_voice_calls (call_id, day, started_at, ended_at, person_key, ip_key, paid_seconds)
    select 'old' || n, '${day}', now() - interval '1 day', now() - interval '23 hours', 'person:' || n, 'ip:x', 300
    from generate_series(1, 20000) as n;
    analyze try_voice_calls;
  `);
  await usage.openVoiceCall({ callId: "late", day, startedAt: new Date(Date.now() - 3_600_000), personKey: "person:p", ipKey: "ip:x", paidSeconds: 300 });
  await usage.openVoiceCall({ callId: "live", day, startedAt: new Date(), personKey: "person:q", ipKey: "ip:x", paidSeconds: 300 });

  expect(await usage.overdueVoiceCalls(new Date(), 30, 10)).toEqual(["late"]);
  expect(await usage.openVoiceCallsOf("person:q")).toEqual(["live"]);
  for (const query of [
    "select call_id from try_voice_calls where ended_at is null and started_at + make_interval(secs => coalesce(paid_seconds, 3600) + 30) < now() limit 10",
    "select call_id from try_voice_calls where person_key = 'person:q' and ended_at is null",
  ]) {
    const steps = await plan(query);
    expect(steps).toContain("using try_voice_calls_open");
    expect(steps).not.toContain("Seq Scan");
  }
});
