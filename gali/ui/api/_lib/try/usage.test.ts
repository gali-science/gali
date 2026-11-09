import { afterEach, expect, test, vi } from "vitest";
import { today } from "./usage.js";

afterEach(() => {
  vi.useRealTimers();
});

test("the demo day turns over at midnight Pacific, not midnight UTC", () => {
  vi.useFakeTimers({ toFake: ["Date"] });

  vi.setSystemTime(new Date("2026-10-30T06:59:00Z"));
  expect(today()).toBe("2026-10-29");
  vi.setSystemTime(new Date("2026-10-30T07:00:00Z"));
  expect(today()).toBe("2026-10-30");
  vi.setSystemTime(new Date("2026-12-15T07:59:00Z"));
  expect(today()).toBe("2026-12-14");
});
