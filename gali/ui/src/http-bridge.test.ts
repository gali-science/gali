import { afterEach, expect, it, vi } from "vitest";
import { configureAuthenticatedFetch } from "./auth-fetch";
import { createGaliClient } from "./http-bridge";
import { createWorkspaceHealthMonitor } from "./workspace-health";

afterEach(() => {
  configureAuthenticatedFetch(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("waits quietly for a token, then opens the event stream", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetch);
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  let token: string | null = null;
  configureAuthenticatedFetch(async () => token);

  const client = createGaliClient({ baseUrl: "/api/gali", health: createWorkspaceHealthMonitor() });
  const off = client.onReviewer(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(fetch).not.toHaveBeenCalled();
  expect(consoleError).not.toHaveBeenCalled();

  token = "token";
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetch).toHaveBeenCalledWith("/api/gali/events", expect.objectContaining({
    headers: expect.any(Headers),
  }));
  expect(consoleError).not.toHaveBeenCalled();
  off();
});
