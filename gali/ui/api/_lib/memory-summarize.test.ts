import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { summarizeTranscript } from "./memory-summarize.js";

const fetchMock = vi.fn();

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  };
}

test("returns the joined output text and defaults to gpt-6-luna", async () => {
  fetchMock.mockResolvedValue(
    okResponse({
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "worked on Demo " },
            { type: "output_text", text: "(key: demo)" },
          ],
        },
      ],
    }),
  );
  const summary = await summarizeTranscript({
    transcript: "User: hi",
    previousSummary: "old",
  });
  expect(summary).toEqual({
    summary: "worked on Demo (key: demo)",
    model: "gpt-6-luna",
  });
  const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  expect(url).toBe("https://api.openai.com/v1/responses");
  const payload = JSON.parse(init.body) as {
    model: string;
    instructions: string;
    input: string;
    max_output_tokens: number;
  };
  expect(payload.model).toBe("gpt-6-luna");
  expect(payload.instructions).toContain("120 words max, plain text only");
  expect(payload.instructions).not.toContain("old");
  expect(payload.input).toContain("Previous note:\nold");
  expect(payload.input).toContain("Transcript:\nUser: hi");
  expect(payload.max_output_tokens).toBe(1000);
});

test("throws on http errors", async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" });
  await expect(
    summarizeTranscript({ transcript: "User: hi", previousSummary: "" }),
  ).rejects.toThrow("memory summarize -> 500");
});

test("throws when the model returns no text", async () => {
  fetchMock.mockResolvedValue(okResponse({ output: [] }));
  await expect(
    summarizeTranscript({ transcript: "User: hi", previousSummary: "" }),
  ).rejects.toThrow("no text");
});
