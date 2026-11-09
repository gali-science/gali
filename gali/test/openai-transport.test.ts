import { expect, test } from "vitest";
import { resolveOpenAiTransport } from "../src/adapters/openai/transport.js";

test("prefers the model gateway", () => {
  expect(resolveOpenAiTransport({
    GALI_MODEL_GATEWAY_URL: "https://gateway.example/v1/",
    GALI_MODEL_GATEWAY_TOKEN: "gateway-token",
    OPENAI_API_KEY: "local-key",
  })).toEqual({ baseUrl: "https://gateway.example/v1", apiKey: "gateway-token", source: "gateway" });
});

test("falls back to a local key outside a sandbox", () => {
  expect(resolveOpenAiTransport({ OPENAI_API_KEY: "local-key" }))
    .toEqual({ baseUrl: "https://api.openai.com/v1", apiKey: "local-key", source: "environment" });
});

test("a hosted sandbox never uses a raw key", () => {
  expect(() => resolveOpenAiTransport({ GALI_SANDBOX_ID: "sbx", OPENAI_API_KEY: "local-key" }))
    .toThrow(/model gateway/);
});

test("half a gateway config is an error", () => {
  expect(() => resolveOpenAiTransport({ GALI_MODEL_GATEWAY_URL: "https://gateway.example/v1" })).toThrow();
});

test("no credential at all is an error", () => {
  expect(() => resolveOpenAiTransport({})).toThrow();
});
