import { expect, test } from "vitest";
import {
  parseTogetherLinkUsage,
  togetherLinkCostMicros,
  togetherLinkUsageRecord,
  useTogetherLink,
} from "./togetherlink.js";

const usage = {
  completedSessions: 1,
  promptTokens: 120,
  cachedTokens: 20,
  completionTokens: 30,
  totalCostUsd: 0.012345,
  models: [{
    model: "zai-org/GLM-5.3",
    promptTokens: 120,
    cachedTokens: 20,
    completionTokens: 30,
    costUsd: 0.012345,
  }],
};

test("normalizes TogetherLink usage and provider-reported cost", () => {
  const parsed = parseTogetherLinkUsage(usage);
  expect(togetherLinkUsageRecord(parsed)).toEqual({
    input_tokens: 120,
    cached_input_tokens: 20,
    output_tokens: 30,
    models: usage.models,
  });
  expect(togetherLinkCostMicros(parsed)).toBe(12_345);
});

test("serves Codex through TogetherLink outside tests", () => {
  expect(useTogetherLink({ NODE_ENV: "production" })).toBe(true);
  expect(useTogetherLink({})).toBe(true);
  expect(useTogetherLink({ NODE_ENV: "test" })).toBe(false);
  expect(useTogetherLink({ NODE_ENV: "test", GALI_CODEX_UPSTREAM: "togetherlink" })).toBe(true);
});

test("rejects malformed TogetherLink usage", () => {
  expect(() => parseTogetherLinkUsage({
    ...usage,
    totalCostUsd: -1,
  })).toThrow(/totalCostUsd is invalid/);
  expect(() => parseTogetherLinkUsage({
    ...usage,
    models: [{ ...usage.models[0], model: "" }],
  })).toThrow(/usage model is invalid/);
});
