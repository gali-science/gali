import { bootTrace } from "./app/boot-trace";

export class AuthRequiredError extends Error {}

type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider | null = null;
let authBypass = false;

export function configureAuthenticatedFetch(
  provider: TokenProvider | null,
  bypass = false,
): void {
  tokenProvider = provider;
  authBypass = bypass;
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const rawUrl =
    input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
  const url = new URL(rawUrl, window.location.origin);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) {
    throw new Error("authenticatedFetch only accepts same-origin /api routes");
  }
  if (authBypass || !tokenProvider) {
    return fetch(input, { ...init, credentials: "same-origin" });
  }
  const ensure = url.pathname.startsWith("/api/sandbox");
  if (ensure) bootTrace("token: waiting");
  const token = await tokenProvider();
  if (ensure) bootTrace(`token: ${token ? "got" : "none"}`);
  if (!token) throw new AuthRequiredError("authentication required");
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [name, value] of new Headers(init.headers).entries()) {
    headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, {
    ...init,
    headers,
    credentials: "same-origin",
  });
}
