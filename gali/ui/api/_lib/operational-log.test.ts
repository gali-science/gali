import { expect, test } from "vitest";
import {
  createOperationalEvent,
  type OperationalEventInput,
} from "./operational-log.js";

test("explicit undefined values do not overwrite operational event defaults", () => {
  const input = {
    eventName: "sandbox.wake.started",
    level: "info",
    eventId: undefined,
    occurredAt: undefined,
    source: undefined,
  } as OperationalEventInput;

  const event = createOperationalEvent(input);

  expect(event.source).toBe("vercel");
  expect(event.eventId).toBeTruthy();
  expect(Date.parse(event.occurredAt)).not.toBeNaN();
});
