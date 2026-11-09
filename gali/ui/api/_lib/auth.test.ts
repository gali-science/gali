import { beforeEach, expect, test, vi } from "vitest";

const authenticateRequest = vi.fn();
const getClerkUser = vi.fn();
const getUserByClerkUserId = vi.fn();
const materializeClerkUser = vi.fn();

vi.mock("@clerk/backend", () => ({
  createClerkClient: () => ({
    authenticateRequest,
    users: { getUser: getClerkUser },
  }),
}));

vi.mock("./users.js", () => ({
  getUserByClerkUserId: (...args: unknown[]) => getUserByClerkUserId(...args),
  materializeClerkUser: (...args: unknown[]) => materializeClerkUser(...args),
}));

function signedIn(clerkUserId: string) {
  return {
    isAuthenticated: true,
    toAuth: () => ({ userId: clerkUserId }),
  };
}

function request() {
  return {
    method: "GET",
    url: "/api/me",
    headers: {
      host: "localhost:5178",
      cookie: "__session=clerk-token",
    },
  };
}

beforeEach(() => {
  authenticateRequest.mockReset();
  getClerkUser.mockReset();
  getUserByClerkUserId.mockReset();
  materializeClerkUser.mockReset();
  process.env.CLERK_PUBLISHABLE_KEY = "pk_test";
  process.env.CLERK_SECRET_KEY = "sk_test";
  process.env.CLERK_JWT_KEY = "test-public-key";
  process.env.CLERK_AUTHORIZED_PARTIES =
    "http://localhost:5178,https://your-app.vercel.app";
  delete process.env.VITE_GALI_DEV_AUTH_BYPASS;
  delete process.env.VERCEL;
});

test("local development bypass materializes a fixed user without Clerk", async () => {
  process.env.VITE_GALI_DEV_AUTH_BYPASS = "1";
  materializeClerkUser.mockResolvedValue({ id: 16 });
  const { getSession } = await import("./auth.js");
  await expect(getSession(request())).resolves.toEqual({
    userId: 16,
    clerkUserId: "local-development",
  });
  expect(materializeClerkUser).toHaveBeenCalledWith({
    clerkUserId: "local-development",
    identityEmail: "local@gali.dev",
    displayName: "Local scientist",
  });
  expect(authenticateRequest).not.toHaveBeenCalled();
});

test("local development bypass fails if enabled on Vercel", async () => {
  process.env.VITE_GALI_DEV_AUTH_BYPASS = "1";
  process.env.VERCEL = "1";
  const { getSession } = await import("./auth.js");
  await expect(getSession(request())).rejects.toThrow(
    "VITE_GALI_DEV_AUTH_BYPASS cannot be enabled on Vercel",
  );
  expect(materializeClerkUser).not.toHaveBeenCalled();
});

test("signed-out requests are rejected before a user lookup", async () => {
  authenticateRequest.mockResolvedValue({ isAuthenticated: false });
  const { getSession } = await import("./auth.js");
  await expect(getSession(request())).resolves.toBeNull();
  expect(getUserByClerkUserId).not.toHaveBeenCalled();
});

test("an existing approved Clerk identity resolves to its internal user", async () => {
  authenticateRequest.mockResolvedValue(signedIn("user_123"));
  getUserByClerkUserId.mockResolvedValue({
    id: 17,
    clerkUserId: "user_123",
    identityEmail: "person@lab.example",
  });
  const { getSession } = await import("./auth.js");
  await expect(getSession(request())).resolves.toEqual({
    userId: 17,
    clerkUserId: "user_123",
  });
  expect(getClerkUser).not.toHaveBeenCalled();
});

test("a first request materializes an approved Clerk identity synchronously", async () => {
  authenticateRequest.mockResolvedValue(signedIn("user_new"));
  getUserByClerkUserId.mockResolvedValue(null);
  getClerkUser.mockResolvedValue({
    primaryEmailAddressId: "email_1",
    emailAddresses: [
      {
        id: "email_1",
        emailAddress: "SCIENTIST@Example.edu",
        verification: { status: "verified" },
      },
    ],
    firstName: "Ada",
    lastName: "Lovelace",
  });
  materializeClerkUser.mockResolvedValue({ id: 18 });
  const { getSession } = await import("./auth.js");
  await expect(getSession(request())).resolves.toEqual({
    userId: 18,
    clerkUserId: "user_new",
  });
  expect(materializeClerkUser).toHaveBeenCalledWith({
    clerkUserId: "user_new",
    identityEmail: "scientist@example.edu",
    displayName: "Ada Lovelace",
  });
});

test("an unverified email is rejected without creating an internal user", async () => {
  authenticateRequest.mockResolvedValue(signedIn("user_unverified"));
  getUserByClerkUserId.mockResolvedValue(null);
  getClerkUser.mockResolvedValue({
    primaryEmailAddressId: "email_1",
    emailAddresses: [
      {
        id: "email_1",
        emailAddress: "person@example.com",
        verification: { status: "unverified" },
      },
    ],
    firstName: "Not",
    lastName: "Verified",
  });
  const { getSession } = await import("./auth.js");
  await expect(getSession(request())).resolves.toEqual({
    denied: "Verify your email address with the sign-in provider, then sign in again.",
  });
  expect(materializeClerkUser).not.toHaveBeenCalled();
});

test("verification uses the JWT key and explicit authorized parties", async () => {
  authenticateRequest.mockResolvedValue({ isAuthenticated: false });
  const { getSession } = await import("./auth.js");
  await getSession(request());
  expect(authenticateRequest).toHaveBeenCalledWith(
    expect.any(Request),
    expect.objectContaining({
      acceptsToken: "session_token",
      authorizedParties: ["http://localhost:5178", "https://your-app.vercel.app"],
      jwtKey: "test-public-key",
    }),
  );
});
