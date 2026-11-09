import { expect, test, vi } from "vitest";
import {
  createActivityTracker,
  shouldSleep,
  startIdleSleepWatcher,
} from "../src/http/idle-sleep.js";

const IDLE_MS = 15 * 60_000;

function snapshot(overrides: Partial<Parameters<typeof shouldSleep>[0]> = {}) {
  return {
    now: IDLE_MS + 1,
    lastActivityAt: 0,
    idleAfterMs: IDLE_MS,
    inFlightRequests: 0,
    activeReviews: 0,
    ...overrides,
  };
}

test("sleeps only when the idle window has passed with nothing in flight", () => {
  expect(shouldSleep(snapshot())).toBe(true);
  expect(shouldSleep(snapshot({ now: IDLE_MS - 1 }))).toBe(false);
  expect(shouldSleep(snapshot({ activeReviews: 1 }))).toBe(false);
  expect(shouldSleep(snapshot({ inFlightRequests: 1 }))).toBe(false);
});

test("a review outlasting the idle window still blocks the sleep", () => {
  expect(shouldSleep(snapshot({ now: 10 * IDLE_MS, activeReviews: 1 }))).toBe(false);
});

test("tracker pairs requests and never goes negative", () => {
  let now = 0;
  const tracker = createActivityTracker(() => now);

  tracker.requestStarted();
  expect(tracker.snapshot(0, IDLE_MS).inFlightRequests).toBe(1);
  tracker.requestFinished();
  expect(tracker.snapshot(0, IDLE_MS).inFlightRequests).toBe(0);
  tracker.requestFinished();
  expect(tracker.snapshot(0, IDLE_MS).inFlightRequests).toBe(0);

  expect(tracker.snapshot(2, IDLE_MS).activeReviews).toBe(2);

  now = 60_000;
  tracker.touch();
  expect(tracker.snapshot(0, IDLE_MS).lastActivityAt).toBe(60_000);
});

test("watcher requests one sleep and restarts its clock so a refusal does not re-fire", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  let now = 0;
  const tracker = createActivityTracker(() => now);
  const logs: string[] = [];
  const stop = startIdleSleepWatcher({
    tracker,
    activeReviews: () => 0,
    sandboxId: "sbx-1",
    sleepUrl: "https://gali.test/api/sandbox?op=sleep",
    sleepToken: "sleep-token",
    idleAfterMs: IDLE_MS,
    checkEveryMs: 60_000,
    log: (message) => logs.push(message),
  });

  now = IDLE_MS + 1;
  await vi.advanceTimersByTimeAsync(60_000);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://gali.test/api/sandbox?op=sleep");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sleep-token");
  expect(JSON.parse(init.body as string)).toEqual({ sandboxId: "sbx-1", reason: "idle 15m" });

  // A refused sleep must not re-fire on the very next tick; the pre-request
  // touch is what restarts the idle window.
  now = IDLE_MS + 61_000;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  expect(logs.some((line) => line.includes("requesting sleep"))).toBe(true);
});

test("watcher stays quiet while a review is running", async () => {
  vi.useFakeTimers();
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  let now = 0;
  const tracker = createActivityTracker(() => now);
  const stop = startIdleSleepWatcher({
    tracker,
    activeReviews: () => 1,
    sandboxId: "sbx-1",
    sleepUrl: "https://gali.test/api/sandbox?op=sleep",
    sleepToken: "sleep-token",
    idleAfterMs: IDLE_MS,
    checkEveryMs: 60_000,
    log: () => {},
  });

  now = 4 * IDLE_MS;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(fetchMock).not.toHaveBeenCalled();

  stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("a 409 refusal is expected and not reported as a failure", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 409 })));
  let now = 0;
  const onFailure = vi.fn();
  const stop = startIdleSleepWatcher({
    tracker: createActivityTracker(() => now),
    activeReviews: () => 0,
    sandboxId: "sbx-1",
    sleepUrl: "https://gali.test/api/sandbox?op=sleep",
    sleepToken: "sleep-token",
    idleAfterMs: IDLE_MS,
    checkEveryMs: 60_000,
    log: () => {},
    onFailure,
  });

  now = IDLE_MS + 1;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(onFailure).not.toHaveBeenCalled();

  stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
