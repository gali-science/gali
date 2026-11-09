import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ReviewProgressDto, ReviewProgressEvent } from "../../../../shared/domain/contracts";

const progress = vi.hoisted(() => ({
  snapshot: null as ReviewProgressDto,
  emit: null as ((event: ReviewProgressEvent) => void) | null,
  cancelled: [] as string[],
}));

vi.mock("../../api", () => ({
  getReviewProgress: async () => progress.snapshot,
  cancelReview: async (key: string) => {
    progress.cancelled.push(key);
    return { cancelled: true };
  },
  onReviewProgress: (cb: (event: ReviewProgressEvent) => void) => {
    progress.emit = cb;
    return () => {
      progress.emit = null;
    };
  },
}));

const { AgentRow, useAgentRun } = await import("./AgentRow");

afterEach(() => {
  cleanup();
  progress.snapshot = null;
  progress.cancelled.length = 0;
});

const startedAt = Date.now() - 70_000;
const entry = (text: string, seconds: number) => ({ text, at: startedAt + seconds * 1000, commands: [] });
const run = (over: Partial<NonNullable<ReviewProgressDto>> = {}): ReviewProgressDto => ({
  title: "Full review",
  startedAt,
  finishedAt: null,
  entries: [],
  trace: [],
  ...over,
});

function Live({ projectKey }: { projectKey: string }) {
  return <AgentRow projectKey={projectKey} run={useAgentRun(projectKey, true)} />;
}

test("the working agent's row says its latest step and time, and Stop cancels; there is no terminal to open", () => {
  render(<AgentRow projectKey="alpha" run={run({ entries: [entry("Reading the paper", 20), entry("Checking Eq. 3", 40)] })} />);
  expect(screen.getByRole("status").textContent).toBe("Checking Eq. 3");
  expect(screen.getByRole("img", { name: "Agent working" })).toBeTruthy();
  expect(screen.getByText(/^1:1\d$/)).toBeTruthy();
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Stop"]);

  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(progress.cancelled).toEqual(["alpha"]);
  expect(screen.getByRole("button", { name: "Stopping…" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("status").textContent).toBe("Stopping…");
});

test("a busy agent with no run yet is getting started and has nothing to stop", () => {
  render(<AgentRow projectKey="alpha" run={null} />);
  expect(screen.getByRole("status").textContent).toBe("Getting started");
  expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
});

test("the row loads the run so far, then shows each new line as it arrives", async () => {
  progress.snapshot = run({ entries: [entry("Reading the paper", 20)] });
  render(<Live projectKey="alpha" />);
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("Reading the paper");

  act(() => progress.emit!({ projectKey: "other", entry: entry("Elsewhere", 30) }));
  expect(screen.getByRole("status").textContent).toBe("Reading the paper");
  act(() => progress.emit!({ projectKey: "alpha", entry: entry("Checking Eq. 3", 40) }));
  expect(screen.getByRole("status").textContent).toBe("Checking Eq. 3");
});
