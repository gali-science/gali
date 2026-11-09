import { afterEach, expect, test, vi } from "vitest";
import {
  authenticatedFetch,
  AuthRequiredError,
  configureAuthenticatedFetch,
} from "./auth-fetch";

afterEach(() => {
  configureAuthenticatedFetch(null);
  vi.unstubAllGlobals();
});

test("adds a fresh Clerk token only to same-origin API requests", async () => {
  const getToken = vi.fn(async () => "clerk-session-token");
  const fetchMock = vi.fn(async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ) => new Response(null, { status: 204 }));
  configureAuthenticatedFetch(getToken);
  vi.stubGlobal("fetch", fetchMock);

  await authenticatedFetch("/api/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  expect(getToken).toHaveBeenCalledOnce();
  const init = fetchMock.mock.calls[0]![1] as RequestInit;
  const headers = new Headers(init.headers);
  expect(headers.get("authorization")).toBe("Bearer clerk-session-token");
  expect(headers.get("content-type")).toBe("application/json");
  expect(init.credentials).toBe("same-origin");
});

test("rejects external destinations and missing sessions", async () => {
  configureAuthenticatedFetch(async () => "token");
  await expect(
    authenticatedFetch("https://api.example.com/v1"),
  ).rejects.toThrow("same-origin /api routes");

  configureAuthenticatedFetch(async () => null);
  await expect(authenticatedFetch("/api/me")).rejects.toBeInstanceOf(AuthRequiredError);
});
