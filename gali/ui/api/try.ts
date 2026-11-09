import crypto from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { GALI_CONFIG } from "../../shared/config.js";
import { PAPER_TITLE_INSTRUCTIONS, paperTitleFromReply } from "../../shared/domain/paper-title.js";
import { errorFields, logOperationalEvent, requestId } from "./_lib/operational-log.js";
import {
  TOGETHERLINK_FAST_MODEL,
  togetherLinkResponsesUrl,
  useTogetherLink,
} from "./_lib/togetherlink.js";
import {
  TRY_ANSWER_INSTRUCTIONS,
  TRY_FILE_CHARS,
  TRY_FIRST_PAGE_CHARS,
  TRY_HISTORY_TURNS,
  TRY_QUESTION_CHARS,
  TRY_VOICE_INSTRUCTIONS,
  tryVoiceTools,
} from "./_lib/try/prompts.js";
import {
  closeVoiceCall,
  findOpenVoiceCall,
  openVoiceCall,
  openVoiceCallsOf,
  overdueVoiceCalls,
  payVoiceCall,
  refundVoice,
  releaseCallSlots,
  spend,
  takeCallSlots,
  today,
  type Spend,
  type VoiceCall,
} from "./_lib/try/usage.js";

// The no-login page: one PDF in the browser, voice and quick answers, nothing stored.
// No sandbox and no account behind either route.

export const config = {
  maxDuration: 60,
};

const ANSWER_TIMEOUT_MS = 45_000;
const VOICE_CALL_MAX_SECONDS = 60 * 60;
const DAILY_VOICE_SECONDS = 2_500 * 60;
const DAILY_ANSWERS = 5_000;
const IP_DAILY_ANSWERS = 500;
const PERSON_MICROS = 10_000_000;
const IP_DAILY_MICROS = 100_000_000;
const VOICE_MICROS_PER_SECOND = 2_500;
const VOICE_PAID_AHEAD_SECONDS = 5 * 60;
const VOICE_GRACE_SECONDS = 30;
const OVERDUE_CALLS_PER_REQUEST = 10;
const OPEN_CALLS_PER_PERSON = 1;
const OPEN_CALLS_PER_IP = 10;
const TEXT_INPUT_MICROS_PER_TOKEN = 0.3;
const TEXT_OUTPUT_MICROS_PER_TOKEN = 1.2;
const TEXT_OVERHEAD_TOKENS = 100;
const SDP_CHARS = 20_000;
const CALL_ID_CHARS = 200;
const PASS_COOKIE = "gali_try";
const PASS_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
const LIMIT_MESSAGE = "Your free demo is used up.";
const BUSY_MESSAGE = "Too many voice calls are open on your network right now. Try again in a few minutes, or type your question.";

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly busy = false) {
    super(message);
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is not set`);
  return value.trim();
}

type TryPass = { id: string };

function passSignature(payload: string): Buffer {
  const key = crypto.createHmac("sha256", requireEnv("GALI_MODEL_GATEWAY_SECRET")).update("gali-try-pass").digest();
  return crypto.createHmac("sha256", key).update(payload).digest();
}

function readPass(req: VercelRequest): { pass: TryPass; fresh: boolean } {
  const fresh = { pass: { id: crypto.randomUUID() }, fresh: true };
  const cookie = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PASS_COOKIE}=`));
  const [payload, signature] = (cookie?.slice(PASS_COOKIE.length + 1) ?? "").split(".");
  if (!payload || !signature) return fresh;
  const expected = passSignature(payload);
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return fresh;
  const pass = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<TryPass>;
  return typeof pass.id === "string" ? { pass: { id: pass.id }, fresh: false } : fresh;
}

function writePass(res: VercelResponse, pass: TryPass): void {
  const payload = Buffer.from(JSON.stringify(pass)).toString("base64url");
  res.setHeader(
    "Set-Cookie",
    `${PASS_COOKIE}=${payload}.${passSignature(payload).toString("base64url")}; Path=/api/try; Max-Age=${PASS_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`,
  );
}

function ipKey(req: VercelRequest, day: string): string {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || "unknown";
  const key = crypto.createHmac("sha256", requireEnv("GALI_MODEL_GATEWAY_SECRET")).update("gali-try-ip").digest();
  return `ip:${day}:${crypto.createHmac("sha256", key).update(ip).digest("base64url")}`;
}

function spendKeys(req: VercelRequest, pass: TryPass, day: string): string[] {
  return [`person:${pass.id}`, ipKey(req, day)];
}

function spendsFor(keys: string[], micros: number): Spend[] {
  return keys.map((key) => ({ key, micros, capMicros: key.startsWith("ip:") ? IP_DAILY_MICROS : PERSON_MICROS }));
}

function callSlots(day: string, keys: string[]): Spend[] {
  return keys.map((key) => ({
    key: `calls:${day}:${key}`,
    micros: 1,
    capMicros: key.startsWith("ip:") ? OPEN_CALLS_PER_IP : OPEN_CALLS_PER_PERSON,
  }));
}

function slotKeys(slots: Spend[]): string[] {
  return slots.map((slot) => slot.key);
}

// A byte-level tokenizer never makes more tokens than UTF-8 bytes, so this bounds what a reply can cost.
function textMicros(instructions: string, input: string, maxOutputTokens: number): number {
  const inputTokens = Buffer.byteLength(instructions + input, "utf8") + TEXT_OVERHEAD_TOKENS;
  return Math.ceil(inputTokens * TEXT_INPUT_MICROS_PER_TOKEN + maxOutputTokens * TEXT_OUTPUT_MICROS_PER_TOKEN);
}

function secondsRun(call: VoiceCall, now: number): number {
  return Math.min(VOICE_CALL_MAX_SECONDS, Math.ceil(Math.max(0, now - call.startedAt.getTime()) / 1000));
}

function callKeys(call: VoiceCall): string[] {
  return [call.personKey, call.ipKey].filter((key): key is string => key !== null);
}

function opOf(req: VercelRequest): string {
  const raw = req.query.op;
  return Array.isArray(raw) ? (raw[0] ?? "") : typeof raw === "string" ? raw : "";
}

async function upstreamJson(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

async function placeVoiceCall(offer: string): Promise<{ id: string; sdp: string }> {
  const { realtime } = GALI_CONFIG;
  const form = new FormData();
  form.set("sdp", offer);
  form.set("session", JSON.stringify({
    type: "realtime",
    model: realtime.model,
    instructions: TRY_VOICE_INSTRUCTIONS,
    reasoning: { effort: realtime.reasoningEffort },
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: { model: realtime.transcribeModel },
        noise_reduction: { type: realtime.noiseReduction },
        turn_detection: {
          type: "semantic_vad",
          eagerness: realtime.vadEagerness,
          create_response: true,
          interrupt_response: true,
        },
      },
      output: { voice: realtime.voice },
    },
    tools: tryVoiceTools(),
    tool_choice: "auto",
  }));
  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
    body: form,
  });
  if (!response.ok) throw new Error(`voice call failed (${response.status}): ${await response.text()}`);
  const id = response.headers.get("location")?.split("/").pop();
  if (!id) throw new Error("voice call response contained no call id");
  return { id, sdp: await response.text() };
}

async function hangUp(callId: string): Promise<void> {
  const response = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`, {
    method: "POST",
    headers: { Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}` },
  });
  // A call the browser already left can no longer be hung up; only 429 and 5xx leave it possibly live.
  if (response.ok || (response.status >= 400 && response.status < 500 && response.status !== 429)) return;
  throw new Error(`voice hangup failed (${response.status}): ${await response.text()}`);
}

async function endVoiceCall(callId: string, now: number): Promise<void> {
  if (!(await findOpenVoiceCall(callId))) return;
  await hangUp(callId);
  const call = await closeVoiceCall(callId, new Date(now));
  if (!call) return;
  await releaseCallSlots(slotKeys(callSlots(call.day, callKeys(call))));
  const unused = Math.max(0, (call.paidSeconds ?? VOICE_CALL_MAX_SECONDS) - secondsRun(call, now));
  await refundVoice(call.day, unused, unused * VOICE_MICROS_PER_SECOND, callKeys(call));
}

async function endVoiceCalls(callIds: string[], now: number, reqId: string, status: string): Promise<void> {
  for (const callId of callIds) {
    await endVoiceCall(callId, now).catch((error: unknown) => {
      logOperationalEvent({
        eventName: "control.request.failed",
        level: "error",
        requestId: reqId,
        status,
        ...errorFields(error),
      });
    });
  }
}

async function payAhead(callId: string, now: number): Promise<void> {
  const call = await findOpenVoiceCall(callId);
  if (!call) throw new HttpError(410, "voice call has ended");
  const paid = call.paidSeconds ?? VOICE_CALL_MAX_SECONDS;
  const target = Math.min(VOICE_CALL_MAX_SECONDS, secondsRun(call, now) + VOICE_PAID_AHEAD_SECONDS);
  const more = target - paid;
  if (more <= 0) return;
  const keys = callKeys(call);
  if (!(await spend(call.day, "voiceSeconds", more, DAILY_VOICE_SECONDS, spendsFor(keys, more * VOICE_MICROS_PER_SECOND)))) {
    throw new HttpError(429, LIMIT_MESSAGE);
  }
  if (!(await payVoiceCall(callId, paid, target))) await refundVoice(call.day, more, more * VOICE_MICROS_PER_SECOND, keys);
}

function bodyRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function offerOf(body: unknown): string {
  const sdp = bodyRecord(body).sdp;
  if (typeof sdp !== "string" || !sdp.trim()) throw new HttpError(400, "sdp is required");
  if (sdp.length > SDP_CHARS) throw new HttpError(413, "sdp is too long");
  // OpenAI cannot parse an offer without its final line break, so it is never trimmed.
  return sdp;
}

type Turn = { role: "user" | "assistant"; text: string };

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${label} is required`);
  if (value.length > max) throw new HttpError(413, `${label} is too long`);
  return value.trim();
}

function parseAnswerInput(body: unknown): { question: string; fileText: string; page: number; history: Turn[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be a JSON object");
  const record = body as Record<string, unknown>;
  const page = Number(record.page);
  if (!Number.isInteger(page) || page < 1) throw new HttpError(400, "page must be a positive integer");
  const rawHistory = record.history ?? [];
  if (!Array.isArray(rawHistory) || rawHistory.length > TRY_HISTORY_TURNS) {
    throw new HttpError(400, `history must be at most ${TRY_HISTORY_TURNS} turns`);
  }
  const history = rawHistory.map((turn: unknown): Turn => {
    const row = (turn ?? {}) as Record<string, unknown>;
    if (row.role !== "user" && row.role !== "assistant") throw new HttpError(400, "history role is invalid");
    return { role: row.role, text: text(row.text, "history text", TRY_QUESTION_CHARS) };
  });
  return {
    question: text(record.question, "question", TRY_QUESTION_CHARS),
    fileText: text(record.fileText, "fileText", TRY_FILE_CHARS),
    page,
    history,
  };
}

async function fastText(
  day: string,
  keys: string[],
  label: string,
  instructions: string,
  input: string,
  maxOutputTokens: number,
): Promise<string> {
  const answerCounts = keys.filter((key) => key.startsWith("ip:")).map((key) => ({ key: `answers:${key}`, micros: 1, capMicros: IP_DAILY_ANSWERS }));
  if (!(await spend(day, "answers", 1, DAILY_ANSWERS, [...spendsFor(keys, textMicros(instructions, input, maxOutputTokens)), ...answerCounts]))) {
    throw new HttpError(429, LIMIT_MESSAGE);
  }
  const togetherLink = useTogetherLink();
  const body = await upstreamJson(
    await fetch(togetherLink ? togetherLinkResponsesUrl() : "https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${requireEnv(togetherLink ? "TOGETHER_API_KEY" : "OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: togetherLink ? TOGETHERLINK_FAST_MODEL : GALI_CONFIG.fastModel,
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        ...(togetherLink ? {} : { reasoning: { effort: "low" } }),
      }),
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    }),
    label,
  );
  let reply = "";
  for (const item of (body.output ?? []) as Array<{ type?: string; content?: Array<{ type?: string; text?: unknown }> | null }>) {
    if (item.type !== "message") continue;
    for (const part of item.content ?? []) {
      if (part.type === "output_text" && typeof part.text === "string") reply += part.text;
    }
  }
  if (!reply.trim()) throw new Error(`${label} response contained no text`);
  return reply.trim();
}

function answer(day: string, keys: string[], input: ReturnType<typeof parseAnswerInput>): Promise<string> {
  const earlier = input.history.length === 0
    ? ""
    : `Earlier in this conversation:\n${input.history.map((turn) => `${turn.role === "user" ? "User" : "You"}: ${turn.text}`).join("\n")}\n\n`;
  return fastText(
    day,
    keys,
    "quick answer",
    TRY_ANSWER_INSTRUCTIONS,
    `File text (pages marked "=== page N ==="):\n${input.fileText}\n\n${earlier}The user is on page ${input.page}.\nQuestion: ${input.question}`,
    2000,
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const reqId = requestId(req, res);
  try {
    if (req.method !== "POST") throw new HttpError(405, "method not allowed");
    const op = opOf(req);
    const now = Date.now();
    const day = today();
    const { pass, fresh } = readPass(req);
    if (fresh) writePass(res, pass);
    await endVoiceCalls(
      await overdueVoiceCalls(new Date(now), VOICE_GRACE_SECONDS, OVERDUE_CALLS_PER_REQUEST),
      now,
      reqId,
      "try-overdue-call",
    );
    if (op === "session") {
      const offer = offerOf(req.body);
      const keys = spendKeys(req, pass, day);
      await endVoiceCalls(await openVoiceCallsOf(keys[0]!), now, reqId, "try-replaced-call");
      const ahead = VOICE_PAID_AHEAD_SECONDS;
      const slots = callSlots(day, keys);
      if (!(await takeCallSlots(slots))) throw new HttpError(429, BUSY_MESSAGE, true);
      if (!(await spend(day, "voiceSeconds", ahead, DAILY_VOICE_SECONDS, spendsFor(keys, ahead * VOICE_MICROS_PER_SECOND)))) {
        await releaseCallSlots(slotKeys(slots));
        throw new HttpError(429, LIMIT_MESSAGE);
      }
      const giveBack = async () => {
        await refundVoice(day, ahead, ahead * VOICE_MICROS_PER_SECOND, keys);
        await releaseCallSlots(slotKeys(slots));
      };
      let call: Awaited<ReturnType<typeof placeVoiceCall>>;
      try {
        call = await placeVoiceCall(offer);
      } catch (error) {
        await giveBack();
        throw error;
      }
      try {
        await openVoiceCall({
          callId: call.id,
          day,
          startedAt: new Date(now),
          personKey: keys[0]!,
          ipKey: keys[1]!,
          paidSeconds: ahead,
        });
      } catch (error) {
        await hangUp(call.id);
        await giveBack();
        throw error;
      }
      res.status(200).json({ sdp: call.sdp, call: call.id });
      return;
    }
    if (op === "extend") {
      await payAhead(text(bodyRecord(req.body).call, "call", CALL_ID_CHARS), now);
      res.status(200).json({ ok: true });
      return;
    }
    if (op === "end") {
      await endVoiceCall(text(bodyRecord(req.body).call, "call", CALL_ID_CHARS), now);
      res.status(200).json({ ok: true });
      return;
    }
    if (op === "answer") {
      res.status(200).json({ answer: await answer(day, spendKeys(req, pass, day), parseAnswerInput(req.body)) });
      return;
    }
    if (op === "title") {
      const firstPage = text(bodyRecord(req.body).firstPage, "firstPage", TRY_FIRST_PAGE_CHARS);
      const reply = await fastText(day, spendKeys(req, pass, day), "paper title", PAPER_TITLE_INSTRUCTIONS, firstPage, 400);
      res.status(200).json({ title: paperTitleFromReply(reply) });
      return;
    }
    throw new HttpError(404, "unknown op");
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.status).json(error.busy ? { error: error.message, busy: true } : { error: error.message });
      return;
    }
    logOperationalEvent({
      eventName: "control.request.failed",
      level: "error",
      requestId: reqId,
      status: `try-${opOf(req)}`,
      ...errorFields(error),
    });
    res.status(502).json({ error: "Gali could not answer just now.", requestId: reqId });
  }
}
