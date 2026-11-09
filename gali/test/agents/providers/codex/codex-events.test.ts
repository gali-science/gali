import { expect, test } from "vitest";
import { mapCodexItem } from "../../../../src/agents/providers/codex/codex-events.js";

test("normalizes app-server message, reasoning, command, and file items", () => {
  expect(mapCodexItem({ id: "m1", type: "agentMessage", text: "done" })).toEqual({ type: "message", text: "done" });
  expect(mapCodexItem({ id: "r1", type: "reasoning", summary: ["Checking Eq. 3"], content: [] }))
    .toEqual({ type: "reasoning", text: "Checking Eq. 3" });
  expect(mapCodexItem({ id: "r2", type: "reasoning", summary: [], content: [] })).toBeNull();
  expect(mapCodexItem({
    id: "c1",
    type: "commandExecution",
    command: "pnpm test",
    status: "completed",
    aggregatedOutput: "passed",
    exitCode: 0,
  })).toEqual({ type: "command", command: "pnpm test", status: "completed", output: "passed", exitCode: 0 });
  expect(mapCodexItem({
    id: "c2",
    type: "commandExecution",
    command: "sleep 9",
    status: "inProgress",
    aggregatedOutput: null,
    exitCode: null,
  })).toEqual({ type: "command", command: "sleep 9", status: "inProgress" });
  expect(mapCodexItem({ id: "f1", type: "fileChange", changes: [{ path: "review.json" }], status: "completed" }))
    .toEqual({ type: "files", paths: ["review.json"], status: "completed" });
  expect(mapCodexItem({ id: "u1", type: "userMessage" })).toBeNull();
  expect(mapCodexItem({ id: "s1", type: "subAgentActivity" })).toBeNull();
});

test("clips huge command output", () => {
  const clipped = mapCodexItem({
    id: "c3",
    type: "commandExecution",
    command: "cat big.html",
    status: "completed",
    aggregatedOutput: "x".repeat(2 * 1024 * 1024),
    exitCode: 0,
  });
  if (clipped?.type !== "command") throw new Error("expected a command event");
  expect(clipped.output!.length).toBeLessThan(65 * 1024);
  expect(clipped.output).toMatch(/… \[truncated \d+ characters\]$/);
});
