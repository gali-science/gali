import { expect, test } from "vitest";
import { asVoiceMemoryDto, buildTranscript } from "./voice-memory";

test("formats user and assistant turns with tool markers", () => {
  const transcript = buildTranscript([
    { kind: "message", role: "user", text: "open demo" },
    { kind: "tool", name: "open_project", args: {}, result: {} },
    { kind: "message", role: "assistant", text: "Demo is open." },
    { kind: "status", text: "connected" },
  ]);
  expect(transcript).toBe("User: open demo\n[tool: open_project]\nGali: Demo is open.");
});

test("skips system messages and blank lines", () => {
  const transcript = buildTranscript([
    { kind: "message", role: "system", text: "silent context" },
    { kind: "message", role: "user", text: "   " },
    { kind: "message", role: "user", text: "hello" },
  ]);
  expect(transcript).toBe("User: hello");
});

test("keeps only the newest lines under the caps", () => {
  const lines = Array.from({ length: 200 }, (_, i) => ({
    kind: "message" as const,
    role: "user",
    text: `line ${i}`,
  }));
  const transcript = buildTranscript(lines);
  const rows = transcript.split("\n");
  expect(rows).toHaveLength(120);
  expect(rows[0]).toBe("User: line 80");
  expect(rows[rows.length - 1]).toBe("User: line 199");
});

test("returns empty string for no usable lines", () => {
  expect(buildTranscript([{ kind: "status", text: "connected" }])).toBe("");
});

test("asVoiceMemoryDto accepts a memory payload and rejects account-shaped JSON", () => {
  expect(
    asVoiceMemoryDto({
      summary: "worked on Demo",
      uiLocation: "on the Home screen",
      endedAt: "2026-08-11T21:00:00.000Z",
    }),
  ).toEqual({
    summary: "worked on Demo",
    uiLocation: "on the Home screen",
    endedAt: "2026-08-11T21:00:00.000Z",
  });
  expect(asVoiceMemoryDto({ username: "ada", email: "ada@example.com" })).toBeNull();
  expect(asVoiceMemoryDto(null)).toBeNull();
});
