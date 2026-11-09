import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createWorkspaceHealthMonitor, RECONNECTING_GRACE_MS } from "./workspace-health";

const failure = {
  kind: "start_failed",
  provider: "vercel",
  detail: "sandbox b is failed_to_start (internal_error)",
} as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test("a blip shorter than the grace period never shows", () => {
  const health = createWorkspaceHealthMonitor();
  const listener = vi.fn();
  health.subscribe(listener);

  health.lost();
  vi.advanceTimersByTime(RECONNECTING_GRACE_MS - 1);
  health.reached();
  vi.advanceTimersByTime(RECONNECTING_GRACE_MS);

  expect(health.current()).toEqual({ state: "ok" });
  expect(listener).not.toHaveBeenCalled();
});

test("an outage past the grace period reads as reconnecting from when it began", () => {
  const health = createWorkspaceHealthMonitor();
  const began = Date.now();

  health.lost();
  vi.advanceTimersByTime(1_000);
  health.lost();
  vi.advanceTimersByTime(RECONNECTING_GRACE_MS);

  expect(health.current()).toEqual({ state: "reconnecting", since: began });
  health.reached();
  expect(health.current()).toEqual({ state: "ok" });
});

test("unavailable shows at once and survives the failing retries that follow", () => {
  const health = createWorkspaceHealthMonitor();

  health.lost();
  health.unavailable(failure);
  expect(health.current()).toEqual({ state: "unavailable", failure });

  health.lost();
  vi.advanceTimersByTime(RECONNECTING_GRACE_MS * 2);
  expect(health.current()).toEqual({ state: "unavailable", failure });

  health.reached();
  expect(health.current()).toEqual({ state: "ok" });
});

test("the same failure reported again does not notify", () => {
  const health = createWorkspaceHealthMonitor();
  health.unavailable(failure);
  const listener = vi.fn();
  health.subscribe(listener);

  health.unavailable({ ...failure });
  expect(listener).not.toHaveBeenCalled();

  health.unavailable({ ...failure, kind: "out_of_capacity" });
  expect(listener).toHaveBeenCalledOnce();
});
