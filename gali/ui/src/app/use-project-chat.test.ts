import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { VoiceLine } from "../useVoice";

const api = vi.hoisted(() => ({
  stored: {} as Record<string, unknown[]>,
  saves: [] as Array<{ key: string; lines: unknown[] }>,
}));

vi.mock("../api", () => ({
  readProjectChat: vi.fn(async (key: string) => ({ lines: api.stored[key] ?? [] })),
  saveProjectChat: vi.fn(async (key: string, lines: unknown[]) => {
    api.saves.push({ key, lines });
    api.stored[key] = lines;
    return { saved: lines.length };
  }),
}));

const { fittedLines, restoredLines, useProjectChat } = await import("./use-project-chat");

beforeEach(() => {
  api.stored = {};
  api.saves = [];
});

const user = (id: number, text: string, projectKey?: string): VoiceLine => ({
  id,
  kind: "message",
  role: "user",
  text,
  ...(projectKey ? { projectKey } : {}),
});

const texts = (lines: VoiceLine[]) => lines.map((line) => (line.kind === "tool" ? line.name : line.text));

test("a project shows its saved chat and its own new lines, never another project's", async () => {
  api.stored.a = [{ kind: "message", role: "user", text: "old question", projectKey: "a" }];
  const live = [user(0, "about a", "a"), user(1, "about b", "b"), user(2, "on home")];

  const { result, rerender } = renderHook(({ open }) => useProjectChat(open, live), {
    initialProps: { open: "a" as string | null },
  });
  await waitFor(() => expect(texts(result.current)).toEqual(["old question", "about a"]));
  expect(new Set(result.current.map((line) => line.id)).size).toBe(2);

  rerender({ open: "b" });
  await waitFor(() => expect(texts(result.current)).toEqual(["about b"]));

  rerender({ open: null });
  expect(texts(result.current)).toEqual(["about a", "about b", "on home"]);
});

test("new lines are saved to their own project after the saved history, even when that project is not open", async () => {
  api.stored.b = [{ kind: "message", role: "assistant", text: "earlier answer", projectKey: "b" }];
  const live = [
    user(0, "about a", "a"),
    { id: 1, kind: "tool", name: "ask_reviewer", args: { projectKey: "b", question: "q" }, result: { asked: true, tree: { big: [1, 2] } }, projectKey: "b" } as VoiceLine,
    user(2, "on home"),
  ];

  renderHook(() => useProjectChat("a", live));

  await waitFor(() => expect(api.saves.map((save) => save.key).sort()).toEqual(["a", "b"]), { timeout: 3_000 });
  expect(api.stored.a).toEqual([{ kind: "message", role: "user", text: "about a", projectKey: "a" }]);
  expect(api.stored.b).toEqual([
    { kind: "message", role: "assistant", text: "earlier answer", projectKey: "b" },
    { kind: "tool", name: "ask_reviewer", args: { projectKey: "b", question: "q" }, result: { asked: true }, projectKey: "b" },
  ]);
});

test("a job ending in another project shows as one line in the open chat, but is saved only to its own project", async () => {
  const status = (id: number, text: string, phase: "background" | "finished" | "failed"): VoiceLine =>
    ({ id, kind: "status", text, projectKey: "b", mark: { type: "reviewer", phase } });
  const live = [
    user(0, "about a", "a"),
    status(1, "Working in the background on b", "background"),
    { id: 2, kind: "message", role: "assistant", text: "Table 2 checks out.", projectKey: "b" } as VoiceLine,
    status(3, "Answer ready on b", "finished"),
    status(4, "Could not finish on b", "failed"),
  ];

  const { result } = renderHook(() => useProjectChat("a", live));

  await waitFor(() => expect(api.saves.map((save) => save.key).sort()).toEqual(["a", "b"]), { timeout: 3_000 });
  expect(texts(result.current)).toEqual(["about a", "Answer ready on b", "Could not finish on b"]);
  expect(api.stored.a).toEqual([{ kind: "message", role: "user", text: "about a", projectKey: "a" }]);
  expect(texts(restoredLines(api.stored.b!))).toEqual([
    "Working in the background on b",
    "Table 2 checks out.",
    "Answer ready on b",
    "Could not finish on b",
  ]);
});

test("a saved chat stays under the server's body limit by dropping its oldest lines", () => {
  const lines = Array.from({ length: 200 }, (_, i) => ({ kind: "message", role: "user", text: `${i} ${"가".repeat(4_000)}` }));
  const kept = fittedLines(lines);
  expect(new TextEncoder().encode(JSON.stringify({ lines: kept })).length).toBeLessThan(1024 * 1024);
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.at(-1)).toBe(lines.at(-1));
  expect(fittedLines(lines.slice(0, 3))).toEqual(lines.slice(0, 3));
});

test("a project whose saved chat cannot be read is not overwritten", async () => {
  const { readProjectChat } = await import("../api");
  const read = vi.mocked(readProjectChat).getMockImplementation();
  vi.mocked(readProjectChat).mockRejectedValue(new Error("asleep"));

  renderHook(() => useProjectChat("a", [user(0, "about a", "a")]));

  await new Promise((resolve) => setTimeout(resolve, 1_300));
  expect(api.saves).toEqual([]);
  vi.mocked(readProjectChat).mockImplementation(read!);
});
