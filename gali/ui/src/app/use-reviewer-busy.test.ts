import { act, renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import type { ReviewerEvent } from "../api";

const reviewer = vi.hoisted(() => ({
  emit: null as null | ((event: ReviewerEvent) => void),
  restart: null as null | (() => void),
}));

vi.mock("../api", () => ({
  onReviewerEvent: (cb: (event: ReviewerEvent) => void) => {
    reviewer.emit = cb;
    return () => {};
  },
  onBackendRestart: (cb: () => void) => {
    reviewer.restart = cb;
    return () => {};
  },
}));

const { useReviewerBusy } = await import("./use-reviewer-busy");

const emit = (event: Record<string, unknown>) => act(() => reviewer.emit?.({ projectKey: "p", seq: 1, ...event } as ReviewerEvent));

test("a background review keeps the reviewer busy after the turn that started it has answered", () => {
  const { result } = renderHook(() => useReviewerBusy());

  emit({ type: "reviewer.started", question: "Review it", summary: "Review" });
  expect(result.current.p).toBe(1);
  emit({ type: "reviewer.reviewing", running: true });
  emit({ type: "reviewer.finished", status: "succeeded", message: "The review has started." });
  expect(result.current.p).toBe(1);
  emit({ type: "reviewer.reviewing", running: false });
  expect(result.current.p).toBe(0);
});

test("a workspace restart clears a reviewer that will never report finishing", () => {
  const { result } = renderHook(() => useReviewerBusy());

  emit({ type: "reviewer.started", question: "Review it", summary: "Review" });
  emit({ type: "reviewer.reviewing", running: true });
  expect(result.current.p).toBe(2);
  act(() => reviewer.restart?.());
  expect(result.current.p).toBeUndefined();
});
