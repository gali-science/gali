import { expect, test } from "vitest";
import { deriveVoiceChrome } from "./voice-chrome";

const base = {
  talkChrome: false,
  error: null,
  connecting: false,
  connected: true,
  muted: false,
  pendingTool: null,
  lines: [],
  reviewerBusy: false,
  trialBlocked: false,
  selectedProjectKey: null,
  projects: [],
};

test("the Gali bar speaks of Gali, never of a separate reviewer", () => {
  expect(deriveVoiceChrome({ ...base, reviewerBusy: true }).label).toBe("Working");
  expect(deriveVoiceChrome({ ...base, talkChrome: true }).echo).toBe("Talk to Gali — open a PDF, ask about a figure, or have Gali check the code.");
  expect(deriveVoiceChrome({ ...base, pendingTool: "ask_reviewer" }).echo).toBe("Asked Gali — the answer comes when it is done.");
});
