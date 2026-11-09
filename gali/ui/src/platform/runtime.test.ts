import { expect, test } from "vitest";
import type { GaliClient } from "../http-bridge";
import { createWorkspaceHealthMonitor } from "../workspace-health";
import { createPlatform } from "./runtime";

const client = {} as GaliClient;

test("hosted platform exposes hosted capabilities", () => {
  const platform = createPlatform("hosted", client, createWorkspaceHealthMonitor());
  expect(platform.capabilities).toEqual({
    sandboxWake: true,
    trialMetering: true,
    downloadFiles: true,
    voiceMemory: "hosted",
  });
});

test("no platform has nothing to wake or meter", () => {
  const platform = createPlatform("none", null, createWorkspaceHealthMonitor());
  expect(platform.capabilities).toEqual({
    sandboxWake: false,
    trialMetering: false,
    downloadFiles: false,
    voiceMemory: "none",
  });
});

test("hosted mode requires a client", () => {
  expect(() => createPlatform("hosted", null, createWorkspaceHealthMonitor())).toThrow(/client is unavailable/);
});
