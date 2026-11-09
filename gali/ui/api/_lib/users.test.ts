import { afterEach, expect, test, vi } from "vitest";
import { sandboxOwnerForClerkUser } from "./users.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("a Clerk user gets a stable non-identifying sandbox owner label", () => {
  const first = sandboxOwnerForClerkUser("user_123");
  expect(first).toBe(sandboxOwnerForClerkUser("user_123"));
  expect(first).toMatch(/^gali-user-[a-f0-9]{24}$/);
  expect(first).not.toContain("user_123");
});

test("a Vercel preview deployment gives the same Clerk user a separate home; production keeps the label", () => {
  const unset = sandboxOwnerForClerkUser("user_123");
  vi.stubEnv("VERCEL_ENV", "production");
  expect(sandboxOwnerForClerkUser("user_123")).toBe(unset);
  vi.stubEnv("VERCEL_ENV", "preview");
  expect(sandboxOwnerForClerkUser("user_123")).toBe(`gali-preview-user-${unset.slice("gali-user-".length)}`);
});

test("different Clerk users do not share an owner label", () => {
  expect(sandboxOwnerForClerkUser("user_123")).not.toBe(
    sandboxOwnerForClerkUser("user_456"),
  );
});
