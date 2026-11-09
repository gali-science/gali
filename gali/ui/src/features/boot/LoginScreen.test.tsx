import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { cloneElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { LoginScreen } from "./LoginScreen";

const openSignIn = vi.fn();
const openWaitlist = vi.fn();
const signInProps = vi.fn();

vi.mock("@clerk/react", () => ({
  SignInButton: ({ children, ...props }: { children: ReactElement<{ onClick?: () => void }> }) => {
    signInProps(props);
    return cloneElement(children, { onClick: openSignIn });
  },
  useClerk: () => ({ openWaitlist }),
}));

afterEach(() => {
  cleanup();
  openSignIn.mockReset();
  openWaitlist.mockReset();
  signInProps.mockReset();
  window.history.replaceState(null, "", "/");
});

test("arriving from the about page with ?waitlist opens Clerk's waitlist once and clears the flag", () => {
  window.history.replaceState(null, "", "/?waitlist");
  render(<LoginScreen />);
  expect(openWaitlist).toHaveBeenCalledOnce();
  expect(openSignIn).not.toHaveBeenCalled();
  expect(window.location.search).toBe("");
});

test("Join the waitlist opens Clerk's waitlist, and Sign in opens sign-in", async () => {
  render(<LoginScreen />);

  await userEvent.click(screen.getByRole("button", { name: "Join the waitlist for Gali's full agent" }));
  expect(openWaitlist).toHaveBeenCalledOnce();
  expect(openSignIn).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(openSignIn).toHaveBeenCalledOnce();
  expect(openWaitlist).toHaveBeenCalledOnce();
});

test("the sign-in popup keeps Clerk's email form, so email users can sign in", () => {
  render(<LoginScreen />);
  expect(signInProps).toHaveBeenCalledWith({ mode: "modal" });
});
