import type { VercelRequest, VercelResponse } from "@vercel/node";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GALI_CONFIG } from "../../shared/config.js";
import { GALI_NAME_PRONUNCIATION } from "../../shared/domain/name-pronunciation.js";
import type { Spend, VoiceCall } from "./_lib/try/usage.js";

const usage = vi.hoisted(() => ({
  spent: new Map<string, number>(),
  keys: new Map<string, number>(),
  calls: new Map<string, VoiceCall & { endedAt: Date | null }>(),
}));

vi.mock("./_lib/try/usage.js", () => {
  const bare = ({ endedAt: _endedAt, ...call }: VoiceCall & { endedAt: Date | null }): VoiceCall => call;
  return {
    today: () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date()),
    spend: async (day: string, counter: string, amount: number, cap: number, spends: Spend[]) => {
      const total = (usage.spent.get(`${day}:${counter}`) ?? 0) + amount;
      if (total > cap) return false;
      if (spends.some((row) => (usage.keys.get(row.key) ?? 0) + row.micros > row.capMicros)) return false;
      usage.spent.set(`${day}:${counter}`, total);
      for (const row of spends) usage.keys.set(row.key, (usage.keys.get(row.key) ?? 0) + row.micros);
      return true;
    },
    refundVoice: async (day: string, seconds: number, micros: number, keys: string[]) => {
      if (seconds === 0) return;
      usage.spent.set(`${day}:voiceSeconds`, usage.spent.get(`${day}:voiceSeconds`)! - seconds);
      for (const key of keys) usage.keys.set(key, usage.keys.get(key)! - micros);
    },
    takeCallSlots: async (slots: Spend[]) => {
      if (slots.some((row) => (usage.keys.get(row.key) ?? 0) + row.micros > row.capMicros)) return false;
      for (const row of slots) usage.keys.set(row.key, (usage.keys.get(row.key) ?? 0) + row.micros);
      return true;
    },
    releaseCallSlots: async (keys: string[]) => {
      for (const key of keys) if (usage.keys.has(key)) usage.keys.set(key, Math.max(0, usage.keys.get(key)! - 1));
    },
    openVoiceCallsOf: async (personKey: string) =>
      [...usage.calls.values()].filter((call) => !call.endedAt && call.personKey === personKey).map((call) => call.callId),
    openVoiceCall: async (call: VoiceCall) => {
      usage.calls.set(call.callId, { ...call, endedAt: null });
    },
    findOpenVoiceCall: async (callId: string) => {
      const call = usage.calls.get(callId);
      return call && !call.endedAt ? bare(call) : null;
    },
    payVoiceCall: async (callId: string, fromSeconds: number, toSeconds: number) => {
      const call = usage.calls.get(callId);
      if (!call || call.endedAt || call.paidSeconds !== fromSeconds) return false;
      call.paidSeconds = toSeconds;
      return true;
    },
    closeVoiceCall: async (callId: string, endedAt: Date) => {
      const call = usage.calls.get(callId);
      if (!call || call.endedAt) return null;
      call.endedAt = endedAt;
      return bare(call);
    },
    overdueVoiceCalls: async (now: Date, graceSeconds: number, limit: number) =>
      [...usage.calls.values()]
        .filter((call) => !call.endedAt && call.startedAt.getTime() + ((call.paidSeconds ?? 3600) + graceSeconds) * 1000 < now.getTime())
        .slice(0, limit)
        .map((call) => call.callId),
  };
});

const DAY = "2026-10-29";
const DAILY_VOICE_SECONDS = 2_500 * 60;
const PERSON_MICROS = 10_000_000;
const IP_DAILY_MICROS = 100_000_000;
const VOICE_MICROS_PER_SECOND = 2_500;
const AHEAD = 300;
const offer = { sdp: "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\na=sctp-port:5000\r\n" };

function openai(options: { hangup?: number; call?: number } = {}) {
  let calls = 0;
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "https://api.openai.com/v1/realtime/calls") {
      calls += 1;
      if (options.call) return new Response("upstream detail", { status: options.call });
      return new Response("answer-sdp", { status: 201, headers: { Location: `/v1/realtime/calls/rtc_${calls}` } });
    }
    if (url === "https://api.openai.com/v1/responses") {
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "Yes." }] }] });
    }
    return new Response(null, { status: options.hangup ?? 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function urls(fetchMock: ReturnType<typeof openai>): string[] {
  return fetchMock.mock.calls.map(([url]) => url);
}

function request(op: string, body: unknown = {}, cookie?: string): VercelRequest {
  return { method: "POST", query: { op }, headers: cookie ? { cookie } : {}, body } as unknown as VercelRequest;
}

function response() {
  const res = {
    statusCode: 200,
    jsonBody: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    json(body: unknown) {
      res.jsonBody = body;
      return res;
    },
  };
  return res;
}

async function run(op: string, body?: unknown, cookie?: string) {
  const { default: handler } = await import("./try.js");
  const res = response();
  await handler(request(op, body, cookie), res as unknown as VercelResponse);
  return res;
}

function passOf(res: ReturnType<typeof response>): string {
  return res.headers["Set-Cookie"]!.split(";")[0]!;
}

function visitor(ip: string, options: { keepsCookie: boolean } = { keepsCookie: true }) {
  let cookie: string | undefined;
  return async (op: string, body?: unknown) => {
    const { default: handler } = await import("./try.js");
    const res = response();
    const headers = { "x-forwarded-for": `${ip}, 10.0.0.1`, ...(cookie ? { cookie } : {}) };
    await handler({ method: "POST", query: { op }, headers, body } as unknown as VercelRequest, res as unknown as VercelResponse);
    const set = res.headers["Set-Cookie"];
    if (set && options.keepsCookie) cookie = set.split(";")[0];
    return res;
  };
}

function spentBy(prefix: "person:" | "ip:"): number[] {
  return [...usage.keys].filter(([key]) => key.startsWith(prefix)).map(([, micros]) => micros);
}

function openSlots(): number[] {
  return [...usage.keys].filter(([key]) => key.startsWith("calls:")).map(([, count]) => count);
}

function setSpent(prefix: "person:" | "ip:", micros: number): void {
  for (const key of usage.keys.keys()) if (key.startsWith(prefix)) usage.keys.set(key, micros);
}

function at(time: string): void {
  vi.setSystemTime(new Date(`${DAY}T${time}Z`));
}

const answerBody = { question: "What is lambda?", fileText: "=== page 1 ===\nλ weights the balance term.", page: 1 };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.useFakeTimers({ toFake: ["Date"] });
  at("10:00:00");
  usage.spent = new Map();
  usage.keys = new Map();
  usage.calls = new Map();
  process.env.OPENAI_API_KEY = "platform-openai-key";
  process.env.TOGETHER_API_KEY = "platform-together-key";
  process.env.GALI_MODEL_GATEWAY_SECRET = "test-gateway-secret";
  delete process.env.GALI_CODEX_UPSTREAM;
});

afterEach(() => {
  vi.useRealTimers();
});

test("the server places the voice call with only the try tools, and the browser gets no key", async () => {
  const fetchMock = openai();

  const res = await run("session", offer);

  expect(res.statusCode).toBe(200);
  expect(res.jsonBody).toEqual({ sdp: "answer-sdp", call: "rtc_1" });
  expect(res.headers["Set-Cookie"]).toMatch(/^gali_try=[^;]+; Path=\/api\/try; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  expect(urls(fetchMock)).toEqual(["https://api.openai.com/v1/realtime/calls"]);
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer platform-openai-key");
  const form = init.body as FormData;
  expect(form.get("sdp")).toBe(offer.sdp);
  const session = JSON.parse(String(form.get("session"))) as { model: string; tools: Array<{ name: string }> };
  expect(session.model).toBe(GALI_CONFIG.realtime.model);
  expect(session.tools.map((tool) => tool.name)).toEqual([
    "quick_answer",
    "set_viewer_page",
    "end_voice",
    "wait_for_user",
  ]);
  expect(usage.calls.get("rtc_1")).toEqual({
    callId: "rtc_1",
    day: DAY,
    startedAt: new Date(`${DAY}T10:00:00Z`),
    endedAt: null,
    personKey: expect.stringMatching(/^person:/),
    ipKey: expect.stringMatching(/^ip:/),
    paidSeconds: AHEAD,
  });
});

test("the demo voice says its name the Italian way, like the app", async () => {
  const fetchMock = openai();
  await run("session", offer);
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const session = JSON.parse(String((init.body as FormData).get("session"))) as { instructions: string };
  expect(session.instructions).toContain(`${GALI_NAME_PRONUNCIATION} Say your own name only when introducing yourself or when asked.`);
});

test("the demo is as brief as the app: one short spoken sentence, and quick answers of at most three", async () => {
  const fetchMock = openai();
  await run("session", offer);
  await run("answer", answerBody);
  const [, voiceInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const voice = JSON.parse(String((voiceInit.body as FormData).get("session"))) as { instructions: string };
  const [, answerInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
  const answer = JSON.parse(String(answerInit.body)) as { instructions: string };
  expect(voice.instructions).toContain("One short sentence by default; two only when needed.");
  expect(voice.instructions).toContain("Never open with a stall");
  expect(answer.instructions).toContain("Answer in one to three short sentences, answer first.");
  expect(answer.instructions).not.toMatch(/five sentences|110 words/);
});

test("a demo quiz asks only the question and keeps its answer for the feedback", async () => {
  const fetchMock = openai();
  await run("session", offer);
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const session = JSON.parse(String((init.body as FormData).get("session"))) as { instructions: string };
  expect(session.instructions).toContain("with its answer\"). Ask only the question.");
  expect(session.instructions).toContain("say what is right, what is missing, and the page that covers it");
});

test("a typed demo quiz asks only the question unless the answer is asked for too", async () => {
  const fetchMock = openai();
  await run("answer", { ...answerBody, question: "Quiz me on this page." });
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  const sent = JSON.parse(String(init.body)) as { instructions: string };
  expect(sent.instructions).toContain("ask one question about the PDF and stop, without the answer, unless they ask for the answer too");
});

test("a person's $10 is their only limit: voice past an hour is fine until the money is spent", async () => {
  openai();
  const alice = visitor("203.0.113.7");
  const clock = (minute: number) => `${10 + Math.floor(minute / 60)}:${String(minute % 60).padStart(2, "0")}:00`;
  const talk = async (call: string, from: number, to: number) => {
    at(clock(from));
    await alice("session", offer);
    for (let minute = from + 4; minute < to; minute += 4) {
      at(clock(minute));
      expect((await alice("extend", { call })).statusCode).toBe(200);
    }
    at(clock(to));
    await alice("end", { call });
  };

  await talk("rtc_1", 0, 31);
  await talk("rtc_2", 32, 63);
  expect(spentBy("person:")).toEqual([2 * 31 * 60 * VOICE_MICROS_PER_SECOND]);

  at("11:04:00");
  setSpent("person:", PERSON_MICROS - 100);
  expect((await alice("session", offer)).statusCode).toBe(429);
  expect((await alice("answer", answerBody)).statusCode).toBe(429);
});

test("the $10 never resets, while an IP's $100 starts over each Pacific day", async () => {
  openai();
  const alice = visitor("203.0.113.7");
  expect((await alice("answer", answerBody)).statusCode).toBe(200);
  setSpent("person:", PERSON_MICROS - 100);
  setSpent("ip:", IP_DAILY_MICROS - 100);
  expect((await visitor("203.0.113.7")("answer", answerBody)).statusCode).toBe(429);

  vi.setSystemTime(new Date("2026-11-20T18:00:00Z"));
  expect((await alice("answer", answerBody)).statusCode).toBe(429);
  expect((await alice("session", offer)).statusCode).toBe(429);
  expect((await visitor("203.0.113.7")("answer", answerBody)).statusCode).toBe(200);
  expect(spentBy("ip:")).toHaveLength(2);
});

test("a call holds only five minutes of the day ahead, and settles to the seconds it ran", async () => {
  const fetchMock = openai();
  const alice = visitor("203.0.113.7");

  await alice("session", offer);
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(AHEAD);
  expect(spentBy("person:")).toEqual([AHEAD * VOICE_MICROS_PER_SECOND]);
  expect(spentBy("ip:")).toEqual([AHEAD * VOICE_MICROS_PER_SECOND]);

  at("10:03:00");
  expect((await alice("extend", { call: "rtc_1" })).statusCode).toBe(200);
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(180 + AHEAD);
  at("10:03:30");
  await alice("extend", { call: "rtc_1" });
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(210 + AHEAD);

  at("10:04:00");
  await alice("end", { call: "rtc_1" });
  expect(urls(fetchMock)).toEqual([
    "https://api.openai.com/v1/realtime/calls",
    "https://api.openai.com/v1/realtime/calls/rtc_1/hangup",
  ]);
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(240);
  expect(spentBy("person:")).toEqual([240 * VOICE_MICROS_PER_SECOND]);
  expect(spentBy("ip:")).toEqual([240 * VOICE_MICROS_PER_SECOND]);

  at("10:05:00");
  expect((await alice("end", { call: "rtc_1" })).statusCode).toBe(200);
  expect((await alice("extend", { call: "rtc_1" })).statusCode).toBe(410);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(240);
});

test("a call nobody pays ahead for is hung up by the next request and costs only what it paid, however late", async () => {
  const fetchMock = openai();
  const alice = visitor("203.0.113.7");
  const bob = visitor("198.51.100.4");
  await alice("session", offer);

  at("10:05:20");
  await bob("answer", answerBody);
  expect(usage.calls.get("rtc_1")!.endedAt).toBeNull();

  at("11:00:00");
  await bob("answer", answerBody);
  expect(usage.calls.get("rtc_1")!.endedAt).toEqual(new Date(`${DAY}T11:00:00Z`));
  expect(urls(fetchMock)).toContain("https://api.openai.com/v1/realtime/calls/rtc_1/hangup");
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(AHEAD);
  expect(spentBy("ip:")).toContain(AHEAD * VOICE_MICROS_PER_SECOND);
  expect((await alice("session", offer)).statusCode).toBe(200);
});

test("held calls no longer lock voice for everyone: the pool fits 500 calls at once, not 41", async () => {
  openai();
  for (let i = 0; i < DAILY_VOICE_SECONDS / AHEAD; i++) {
    expect((await visitor(`203.0.113.${i % 250}`)("session", offer)).statusCode).toBe(200);
  }
  expect((await visitor("198.51.100.4")("session", offer)).statusCode).toBe(429);
});

test("paying ahead stops at OpenAI's 60-minute call length and when the person's $10 is spent", async () => {
  openai();
  const alice = visitor("203.0.113.7");
  await alice("session", offer);
  for (let minute = 4; minute < 60; minute += 4) {
    at(`10:${String(minute).padStart(2, "0")}:00`);
    expect((await alice("extend", { call: "rtc_1" })).statusCode).toBe(200);
  }
  expect(usage.calls.get("rtc_1")!.paidSeconds).toBe(3600);
  at("11:00:01");
  expect((await alice("extend", { call: "rtc_1" })).statusCode).toBe(200);
  expect(usage.calls.get("rtc_1")!.paidSeconds).toBe(3600);

  const bob = visitor("198.51.100.4");
  at("11:01:00");
  await bob("session", offer);
  setSpent("person:", PERSON_MICROS - 60 * VOICE_MICROS_PER_SECOND);
  const before = usage.spent.get(`${DAY}:voiceSeconds`);
  at("11:03:00");
  const refused = await bob("extend", { call: "rtc_2" });
  expect(refused.statusCode).toBe(429);
  expect(refused.jsonBody).toEqual({ error: "Your free demo is used up." });
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(before);
});

test("a person has one open call: a new call ends the old one and refunds its unused minutes", async () => {
  const fetchMock = openai();
  const alice = visitor("203.0.113.7");

  await alice("session", offer);
  at("10:01:00");
  expect((await alice("session", offer)).statusCode).toBe(200);

  expect(urls(fetchMock)).toEqual([
    "https://api.openai.com/v1/realtime/calls",
    "https://api.openai.com/v1/realtime/calls/rtc_1/hangup",
    "https://api.openai.com/v1/realtime/calls",
  ]);
  expect(usage.calls.get("rtc_1")!.endedAt).toEqual(new Date(`${DAY}T10:01:00Z`));
  expect(usage.calls.get("rtc_2")!.endedAt).toBeNull();
  expect(spentBy("person:")).toEqual([(60 + AHEAD) * VOICE_MICROS_PER_SECOND]);
  expect(openSlots()).toEqual([1, 1]);
});

test("one person starting two calls at once gets only one", async () => {
  const fetchMock = openai();
  const first = await run("session", offer);
  const cookie = passOf(first);
  await run("end", { call: "rtc_1" }, cookie);

  const both = await Promise.all([run("session", offer, cookie), run("session", offer, cookie)]);

  expect(both.map((res) => res.statusCode).sort()).toEqual([200, 429]);
  expect(urls(fetchMock).filter((url) => url.endsWith("/realtime/calls"))).toHaveLength(2);
});

test("one network holds at most 10 open calls, and a slot frees when a call ends", async () => {
  const fetchMock = openai();
  const script = visitor("203.0.113.7", { keepsCookie: false });

  for (let i = 0; i < 10; i++) expect((await script("session", offer)).statusCode).toBe(200);
  const refused = await script("session", offer);
  expect(refused.statusCode).toBe(429);
  expect(refused.jsonBody).toEqual({
    error: "Too many voice calls are open on your network right now. Try again in a few minutes, or type your question.",
    busy: true,
  });
  expect(urls(fetchMock).filter((url) => url.endsWith("/realtime/calls"))).toHaveLength(10);
  expect(spentBy("ip:")).toEqual([10 * AHEAD * VOICE_MICROS_PER_SECOND]);
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(10 * AHEAD);

  expect((await visitor("198.51.100.4")("session", offer)).statusCode).toBe(200);
  await script("end", { call: "rtc_3" });
  expect((await script("session", offer)).statusCode).toBe(200);
});

test("calls that stop paying are ended and free their network's slots", async () => {
  openai();
  const script = visitor("203.0.113.7", { keepsCookie: false });
  for (let i = 0; i < 10; i++) await script("session", offer);
  at("10:04:00");
  expect((await script("session", offer)).statusCode).toBe(429);

  at("10:05:31");
  expect((await script("session", offer)).statusCode).toBe(200);
  expect([...usage.calls.values()].filter((call) => !call.endedAt)).toHaveLength(1);
});

test("a call OpenAI would not hang up stays counted, and a later request hangs it up", async () => {
  const fetchMock = openai({ hangup: 503 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const alice = visitor("203.0.113.7");

  await alice("session", offer);
  at("10:00:30");
  const ended = await alice("end", { call: "rtc_1" });
  expect(ended.statusCode).toBe(502);
  expect(urls(fetchMock)[1]).toBe("https://api.openai.com/v1/realtime/calls/rtc_1/hangup");
  expect(usage.calls.get("rtc_1")!.endedAt).toBeNull();
  expect(openSlots()).toEqual([1, 1]);
  expect((await alice("session", offer)).jsonBody).toMatchObject({ busy: true });
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(AHEAD);

  const retried = openai();
  at("10:06:00");
  await visitor("198.51.100.4")("answer", answerBody);
  expect(urls(retried)).toContain("https://api.openai.com/v1/realtime/calls/rtc_1/hangup");
  expect(usage.calls.get("rtc_1")!.endedAt).toEqual(new Date(`${DAY}T10:06:00Z`));
  expect(openSlots()).toEqual([0, 0]);
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(AHEAD);
});

test("a call the browser already left is refunded when OpenAI says it is gone", async () => {
  openai({ hangup: 404 });

  const started = await run("session", offer);
  at("10:00:30");
  await run("end", { call: "rtc_1" }, passOf(started));

  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(30);
});

test("a call OpenAI refuses gives back what it took", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  openai({ call: 500 });

  const res = await visitor("203.0.113.7")("session", offer);

  expect(res.statusCode).toBe(502);
  expect(JSON.stringify(res.jsonBody)).not.toContain("upstream detail");
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(0);
  expect(spentBy("person:")).toEqual([0]);
  expect(spentBy("ip:")).toEqual([0]);
  expect(openSlots()).toEqual([0, 0]);
});

test("a tampered pass is not trusted", async () => {
  openai();
  const first = await run("session", offer);
  const [payload, signature] = passOf(first).slice("gali_try=".length).split(".");
  const forged = Buffer.from(JSON.stringify({ id: "someone-else" })).toString("base64url");
  expect(forged).not.toBe(payload);

  await run("session", offer, `gali_try=${passOf(first).slice("gali_try=".length)}`);
  expect(spentBy("person:")).toHaveLength(1);
  const res = await run("session", offer, `gali_try=${forged}.${signature}`);

  expect(res.statusCode).toBe(200);
  expect(spentBy("person:")).toHaveLength(2);
  expect([...usage.keys.keys()].join(" ")).not.toContain("someone-else");
});

test("the daily voice budget is 2,500 minutes and refuses a call before OpenAI is called", async () => {
  const fetchMock = openai();
  usage.spent.set(`${DAY}:voiceSeconds`, DAILY_VOICE_SECONDS - AHEAD);
  expect((await run("session", offer)).statusCode).toBe(200);

  const res = await run("session", offer);

  expect(res.statusCode).toBe(429);
  expect(res.jsonBody).toEqual({ error: "Your free demo is used up." });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(usage.spent.get(`${DAY}:voiceSeconds`)).toBe(DAILY_VOICE_SECONDS);
});

test("a session without a connection offer is refused before anything is spent", async () => {
  const fetchMock = openai();

  expect((await run("session", {})).statusCode).toBe(400);
  expect((await run("session", { sdp: "x".repeat(20_001) })).statusCode).toBe(413);
  expect((await run("end", {})).statusCode).toBe(400);
  expect((await run("extend", {})).statusCode).toBe(400);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(usage.spent.size).toBe(0);
});

test("colleagues on one IP each get their own $10, and the IP as a whole gets $100", async () => {
  const fetchMock = openai();
  const alice = visitor("203.0.113.7");
  const bob = visitor("203.0.113.7");
  const carol = visitor("198.51.100.4");

  expect((await alice("answer", answerBody)).statusCode).toBe(200);
  setSpent("person:", PERSON_MICROS - 100);
  const answers = fetchMock.mock.calls.length;
  expect((await alice("answer", answerBody)).statusCode).toBe(429);
  expect((await alice("title", { firstPage: "Attention" })).statusCode).toBe(429);
  expect(fetchMock).toHaveBeenCalledTimes(answers);
  expect(usage.spent.get(`${DAY}:answers`)).toBe(1);

  expect((await bob("answer", answerBody)).statusCode).toBe(200);
  expect(spentBy("person:")).toHaveLength(2);
  expect(spentBy("ip:")).toHaveLength(1);

  setSpent("ip:", IP_DAILY_MICROS - 100);
  expect((await bob("answer", answerBody)).statusCode).toBe(429);
  expect((await carol("answer", answerBody)).statusCode).toBe(200);
  expect([...usage.keys.keys()].join(" ")).not.toMatch(/203\.0\.113\.7|198\.51\.100\.4/);
});

test("a script that throws the cookie away is a new person each time but still hits its IP's $100", async () => {
  openai();
  const script = visitor("203.0.113.7", { keepsCookie: false });

  expect((await script("answer", answerBody)).statusCode).toBe(200);
  expect((await script("answer", answerBody)).statusCode).toBe(200);
  expect(spentBy("person:")).toHaveLength(2);

  setSpent("ip:", IP_DAILY_MICROS - 100);
  expect((await script("answer", answerBody)).statusCode).toBe(429);
  const session = await script("session", offer);
  expect(session.statusCode).toBe(429);
  expect(session.jsonBody).toEqual({ error: "Your free demo is used up." });
  expect(openSlots()).toEqual([0, 0]);
});

test("one network gets 500 typed answers and titles a day, so it cannot use up everyone's 5,000", async () => {
  const fetchMock = openai();
  const script = visitor("203.0.113.7", { keepsCookie: false });
  expect((await script("answer", answerBody)).statusCode).toBe(200);
  expect((await script("title", { firstPage: "Attention" })).statusCode).toBe(200);
  const [counter] = [...usage.keys.keys()].filter((key) => key.startsWith("answers:ip:"));
  expect(usage.keys.get(counter!)).toBe(2);

  usage.keys.set(counter!, 500);
  const asked = fetchMock.mock.calls.length;
  const refused = await script("answer", answerBody);
  expect(refused.statusCode).toBe(429);
  expect(refused.jsonBody).toEqual({ error: "Your free demo is used up." });
  expect((await script("title", { firstPage: "Attention" })).statusCode).toBe(429);
  expect(fetchMock).toHaveBeenCalledTimes(asked);
  expect(usage.spent.get(`${DAY}:answers`)).toBe(2);
  expect((await visitor("198.51.100.4")("answer", answerBody)).statusCode).toBe(200);

  vi.setSystemTime(new Date("2026-10-30T18:00:00Z"));
  expect((await script("answer", answerBody)).statusCode).toBe(200);
});

test("a typed answer is charged up front at the most its tokens could cost", async () => {
  openai();
  const fileText = `=== page 1 ===\n${"é".repeat(119_000)}`;

  await run("answer", { ...answerBody, fileText });

  const [charged] = spentBy("person:");
  expect(charged).toBeGreaterThan(Buffer.byteLength(fileText) * 0.3 + 2_000 * 1.2);
  expect(charged).toBeLessThan(Buffer.byteLength(fileText) * 0.3 + 2_000 * 1.2 + 5_000);
});

test("title asks the fast model for the paper's title from the first page, and counts as an answer", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "“Attention Is All You Need”" }] }] }))
    .mockResolvedValueOnce(Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "NONE" }] }] }));
  vi.stubGlobal("fetch", fetchMock);

  const found = await run("title", { firstPage: "Attention Is All You Need\nAshish Vaswani" });
  const none = await run("title", { firstPage: "1 Introduction" });

  expect(found.jsonBody).toEqual({ title: "Attention Is All You Need" });
  expect(none.jsonBody).toEqual({ title: null });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.openai.com/v1/responses");
  const sent = JSON.parse(String(init.body)) as { instructions: string; input: string };
  expect(sent.instructions).toContain("reply with the paper's title only");
  expect(sent.input).toBe("Attention Is All You Need\nAshish Vaswani");
  expect(usage.spent.get(`${DAY}:answers`)).toBe(2);
});

test("title is refused when the daily answer cap is reached, and rejects a missing or oversized page", async () => {
  usage.spent.set(`${DAY}:answers`, 5_000);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  expect((await run("title", { firstPage: "Attention" })).statusCode).toBe(429);
  expect((await run("title", {})).statusCode).toBe(400);
  expect((await run("title", { firstPage: "x".repeat(6_001) })).statusCode).toBe(413);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("the daily answer cap refuses an answer before any model is called or anyone is charged", async () => {
  usage.spent.set(`${DAY}:answers`, 5_000);
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  const res = await run("answer", answerBody);

  expect(res.statusCode).toBe(429);
  expect(usage.spent.get(`${DAY}:answers`)).toBe(5_000);
  expect(usage.keys.size).toBe(0);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("answer sends the file text and question to the OpenAI fast model", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    output: [{ type: "message", content: [{ type: "output_text", text: " It weights the balance term. " }] }],
  }));
  vi.stubGlobal("fetch", fetchMock);

  const res = await run("answer", {
    ...answerBody,
    history: [{ role: "user", text: "Summarize it." }, { role: "assistant", text: "It routes frames." }],
  });

  expect(res.statusCode).toBe(200);
  expect(res.jsonBody).toEqual({ answer: "It weights the balance term." });
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://api.openai.com/v1/responses");
  const sent = JSON.parse(String(init.body)) as { model: string; input: string };
  expect(sent.model).toBe(GALI_CONFIG.fastModel);
  expect(sent.input).toContain("λ weights the balance term.");
  expect(sent.input).toContain("User: Summarize it.\nYou: It routes frames.");
  expect(sent.input).toContain("The user is on page 1.\nQuestion: What is lambda?");
});

test("answer goes to the TogetherLink fast model when TogetherLink is the upstream", async () => {
  process.env.GALI_CODEX_UPSTREAM = "togetherlink";
  const fetchMock = vi.fn().mockResolvedValue(Response.json({
    output: [{ type: "message", content: [{ type: "output_text", text: "Yes." }] }],
  }));
  vi.stubGlobal("fetch", fetchMock);

  await run("answer", answerBody);

  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://gateway.togetherlink.dev/v1/responses");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer platform-together-key");
  expect((JSON.parse(String(init.body)) as { model: string }).model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017");
});

test("the demo leaves DeepSeek on its default reasoning effort, and keeps OpenAI on low", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => Response.json({
    output: [{ type: "message", content: [{ type: "output_text", text: "Yes." }] }],
  }));
  vi.stubGlobal("fetch", fetchMock);

  await run("answer", answerBody);
  process.env.GALI_CODEX_UPSTREAM = "togetherlink";
  await run("answer", answerBody);

  const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { reasoning?: unknown });
  expect(bodies[0]!.reasoning).toEqual({ effort: "low" });
  expect(bodies[1]).not.toHaveProperty("reasoning");
});

test("answer rejects oversized or malformed input without calling a model", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  expect((await run("answer", { ...answerBody, fileText: "x".repeat(120_001) })).statusCode).toBe(413);
  expect((await run("answer", { ...answerBody, question: "" })).statusCode).toBe(400);
  expect((await run("answer", { ...answerBody, page: 0 })).statusCode).toBe(400);
  expect((await run("answer", { ...answerBody, history: Array(7).fill({ role: "user", text: "hi" }) })).statusCode).toBe(400);
  expect((await run("nope")).statusCode).toBe(404);
  expect(fetchMock).not.toHaveBeenCalled();
});

test("an upstream failure is a 502 without the upstream's message", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("secret detail", { status: 500 })));

  const res = await run("answer", answerBody);

  expect(res.statusCode).toBe(502);
  expect(JSON.stringify(res.jsonBody)).not.toContain("secret detail");
});
