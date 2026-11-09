import { expect, test } from "vitest";
import { checkModelPrice, priceUsage, pricingHealth } from "./pricing.js";

const realtimeUsage = {
  input_tokens: 180,
  input_token_details: {
    text_tokens: 100,
    audio_tokens: 80,
    cached_tokens: 50,
    cached_tokens_details: { text_tokens: 30, audio_tokens: 20 },
  },
  output_tokens: 50,
  output_token_details: { text_tokens: 20, audio_tokens: 30 },
};

test("prices Responses usage with cached input", () => {
  expect(
    priceUsage("gpt-5.6-sol", {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 10,
    }, "responses"),
  ).toBe(528);
});

test("prices gpt-6.1-sol Responses usage with cached input", () => {
  expect(
    priceUsage("gpt-6.1-sol", {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens: 10,
    }, "responses"),
  ).toBe(262);
});

test("prices realtime text and audio token details", () => {
  expect(priceUsage("gpt-realtime-2.1", realtimeUsage, "realtime")).toBe(4_620);
});

test("prices realtime image tokens", () => {
  expect(
    priceUsage("gpt-realtime-2.1", {
      input_tokens: 100,
      input_token_details: {
        image_tokens: 100,
        cached_tokens: 20,
        cached_tokens_details: { image_tokens: 20 },
      },
      output_tokens: 0,
    }, "realtime"),
  ).toBe(410);
});

test("prices transcription by audio duration", () => {
  expect(
    priceUsage("gpt-transcribe", { type: "duration", seconds: 30 }, "transcription"),
  ).toBe(2_250);
  expect(
    priceUsage("whisper-1", { type: "duration", seconds: 30 }, "transcription"),
  ).toBe(3_000);
});

test("every configured model has the prices its usage requires", () => {
  checkModelPrice("gpt-6.1-sol", "responses");
  checkModelPrice("gpt-5.6-sol", "responses");
  checkModelPrice("gpt-6-luna", "memory");
  checkModelPrice("gpt-realtime-2.1", "realtime");
  checkModelPrice("gpt-transcribe", "transcription");
  checkModelPrice("whisper-1", "transcription");
  expect(pricingHealth().missing).toEqual([]);
});

test("an unpriced model is charged at its usage type's reference price and reported", () => {
  expect(priceUsage("gpt-realtime-9", realtimeUsage, "realtime")).toBe(4_620);
  expect(
    priceUsage("gpt-transcribe-9", { type: "duration", seconds: 30 }, "transcription"),
  ).toBe(2_250);
  expect(() => checkModelPrice("gpt-realtime-9", "realtime")).not.toThrow();
  expect(pricingHealth().missing).toContain("gpt-realtime-9.input");
  expect(pricingHealth().missing).toContain("gpt-realtime-9.audioOutput");
  expect(pricingHealth().missing).toContain("gpt-transcribe-9.input");
});
