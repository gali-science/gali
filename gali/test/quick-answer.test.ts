import { expect, test, vi } from "vitest";

const fastModelText = vi.hoisted(() => vi.fn(async (_input: { instructions: string }) => "On page 2."));
vi.mock("../src/adapters/openai/fast-model.js", () => ({ fastModelText }));

const { quickAnswer } = await import("../src/adapters/openai/quick-answer.js");

test("pages are the PDF's page markers, never the numbers printed in the paper", async () => {
  await quickAnswer({ question: "Which page has the methods?", paperText: "=== page 1 ===\nIntro\n3735\n=== page 2 ===\nMethods\n3736" });
  const { instructions } = fastModelText.mock.calls[0]![0];
  expect(instructions).toContain('"=== page N ==="');
  expect(instructions).toMatch(/printed/);
});
