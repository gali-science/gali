import { GALI_CONFIG } from "../../../shared/config.js";

export type UsageRecord = Record<string, unknown>;

type ModelPrice = {
  input?: number;
  cachedInput?: number;
  output?: number;
  audioInput?: number;
  cachedAudioInput?: number;
  audioOutput?: number;
  imageInput?: number;
  cachedImageInput?: number;
  perMinute?: number;
};

type PriceKey = keyof ModelPrice;

// USD per 1M tokens (perMinute: USD per audio minute), from OpenAI's pricing page.
// gpt-5.6-sol is promotional pricing, guaranteed only through 2026-11-21.
const MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-6.1-sol": { input: 2, cachedInput: 0.1, output: 10 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "gpt-realtime-2.1": {
    input: 4,
    cachedInput: 0.4,
    output: 24,
    audioInput: 32,
    cachedAudioInput: 0.4,
    audioOutput: 64,
    imageInput: 5,
    cachedImageInput: 0.5,
  },
  "gpt-transcribe": { perMinute: 0.0045 },
  "whisper-1": { perMinute: 0.006 },
};

export type PriceKind = "responses" | "realtime" | "transcription" | "memory";

const FALLBACK_MODEL: Record<PriceKind, string> = {
  responses: "gpt-6.1-sol",
  realtime: "gpt-realtime-2.1",
  transcription: "gpt-transcribe",
  memory: "gpt-6-luna",
};

const REQUIRED_KEYS: Record<PriceKind, PriceKey[]> = {
  responses: ["input", "cachedInput", "output"],
  realtime: [
    "input",
    "cachedInput",
    "output",
    "audioInput",
    "cachedAudioInput",
    "audioOutput",
    "imageInput",
    "cachedImageInput",
  ],
  transcription: ["perMinute"],
  memory: ["input", "cachedInput", "output"],
};

const missingPrices = new Set<string>();

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function numberValue(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

function count(record: Record<string, unknown>, key: string): number {
  return numberValue(record[key], key);
}

function noteMissing(model: string, key: PriceKey): void {
  const id = `${model}.${key}`;
  if (!missingPrices.has(id)) {
    missingPrices.add(id);
    console.error(`[gali] missing model price: ${id}`);
  }
}

function rate(model: string, row: ModelPrice | undefined, key: PriceKey, tokens: number): number {
  if (tokens === 0) return 0;
  const value = row?.[key];
  if (value === undefined) {
    noteMissing(model, key);
    throw new Error(`no price for ${model}.${key}`);
  }
  return value;
}

function tokenCost(tokens: number, dollarsPerMillion: number): number {
  return (tokens * dollarsPerMillion) / 1_000_000;
}

export function priceUsage(model: string, usage: UsageRecord, kind: PriceKind): number {
  const known = MODEL_PRICES[model];
  if (!known) noteMissing(model, "input");
  const row = known ?? MODEL_PRICES[FALLBACK_MODEL[kind]];

  if (usage.type === "duration") {
    const seconds = numberValue(usage.seconds, "seconds");
    const perMinute = rate(model, row, "perMinute", seconds);
    return Math.round(((seconds / 60) * perMinute) * 1_000_000);
  }

  const inputDetails = asRecord(usage.input_token_details ?? usage.input_tokens_details);
  const outputDetails = asRecord(usage.output_token_details ?? usage.output_tokens_details);
  const cachedDetails = asRecord(inputDetails.cached_tokens_details);
  const totalInput = count(usage, "input_tokens") || count(usage, "prompt_tokens");
  const totalOutput = count(usage, "output_tokens");
  const textInput = count(inputDetails, "text_tokens");
  const audioInput = count(inputDetails, "audio_tokens");
  const textOutput = count(outputDetails, "text_tokens");
  const audioOutput = count(outputDetails, "audio_tokens");
  const imageInput = count(inputDetails, "image_tokens");
  const cachedTotal = count(inputDetails, "cached_tokens");
  const cachedText = count(cachedDetails, "text_tokens");
  const cachedAudio = count(cachedDetails, "audio_tokens");
  const cachedImage = count(cachedDetails, "image_tokens");
  const detailedInput = textInput + audioInput + imageInput > 0;
  const detailedOutput = textOutput + audioOutput > 0;
  const remainingCached = Math.max(0, cachedTotal - cachedText - cachedAudio - cachedImage);
  const billedCachedText = cachedText + remainingCached;
  const uncachedText = Math.max(0, (detailedInput ? textInput : totalInput) - billedCachedText);
  const uncachedAudio = Math.max(0, audioInput - cachedAudio);
  const uncachedImage = Math.max(0, imageInput - cachedImage);
  const billedTextOutput = detailedOutput ? textOutput : totalOutput;

  const dollars =
    tokenCost(uncachedText, rate(model, row, "input", uncachedText))
    + tokenCost(uncachedAudio, rate(model, row, "audioInput", uncachedAudio))
    + tokenCost(billedCachedText, rate(model, row, "cachedInput", billedCachedText))
    + tokenCost(cachedAudio, rate(model, row, "cachedAudioInput", cachedAudio))
    + tokenCost(uncachedImage, rate(model, row, "imageInput", uncachedImage))
    + tokenCost(cachedImage, rate(model, row, "cachedImageInput", cachedImage))
    + tokenCost(billedTextOutput, rate(model, row, "output", billedTextOutput))
    + tokenCost(audioOutput, rate(model, row, "audioOutput", audioOutput));

  return Math.round(dollars * 1_000_000);
}

export function checkModelPrice(model: string, kind: PriceKind): void {
  const row = MODEL_PRICES[model];
  for (const key of REQUIRED_KEYS[kind]) {
    if (row?.[key] === undefined) noteMissing(model, key);
  }
}

export function pricingHealth(): { missing: string[] } {
  checkModelPrice(GALI_CONFIG.codexModel, "responses");
  checkModelPrice(GALI_CONFIG.fastModel, "responses");
  checkModelPrice(GALI_CONFIG.realtime.model, "realtime");
  checkModelPrice(GALI_CONFIG.realtime.transcribeModel, "transcription");
  checkModelPrice("gpt-6-luna", "memory");
  return { missing: [...missingPrices].sort() };
}
