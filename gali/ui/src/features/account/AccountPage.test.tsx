import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { isTranscriptDebug } from "../../transcript-debug";
import { AccountPage } from "./AccountPage";

const getAccount = vi.fn();
const signOut = vi.fn();

vi.mock("../../account", () => ({
  getAccount: (...args: unknown[]) => getAccount(...args),
}));

vi.mock("../../auth", () => ({
  useGaliAuth: () => ({
    isLoaded: true,
    isSignedIn: true,
    signOut,
  }),
}));

afterEach(() => {
  cleanup();
  getAccount.mockReset();
  signOut.mockReset();
});

test("shows identity and signs out", async () => {
  getAccount.mockResolvedValue({
    displayName: "Ada Lovelace",
    identityEmail: "ada@example.com",
  });
  render(<AccountPage />);

  expect(await screen.findByText("Ada Lovelace · ada@example.com")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
  expect(signOut).toHaveBeenCalledWith({ redirectUrl: "/" });
});

test("the Back to Home button goes home, and shows only when given a way home", async () => {
  getAccount.mockResolvedValue(null);
  const onGoHome = vi.fn();
  const { rerender } = render(<AccountPage onGoHome={onGoHome} />);
  await userEvent.click(await screen.findByRole("button", { name: "Back to Home" }));
  expect(onGoHome).toHaveBeenCalledOnce();
  expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();

  rerender(<AccountPage />);
  expect(screen.queryByRole("button", { name: "Back to Home" })).toBeNull();
});

test("opens the demo terms", async () => {
  getAccount.mockResolvedValue({
    displayName: "Ada Lovelace",
    identityEmail: "ada@example.com",
  });
  render(<AccountPage />);

  await userEvent.click(await screen.findByRole("button", { name: "Demo Terms" }));
  expect(screen.getByRole("dialog", { name: "Gali Demo Terms" })).toBeTruthy();
});

test("links to the about page", async () => {
  getAccount.mockResolvedValue(null);
  render(<AccountPage />);
  expect((await screen.findByRole("link", { name: "About Gali" })).getAttribute("href")).toBe("/about/");
});

test("About and Terms come before Session, and every action is a button-style control", async () => {
  getAccount.mockResolvedValue(null);
  render(<AccountPage />);
  await waitFor(() => expect(getAccount).toHaveBeenCalled());
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["About", "Terms", "Session"]);
  for (const control of [
    screen.getByRole("link", { name: "About Gali" }),
    screen.getByRole("button", { name: "Demo Terms" }),
    screen.getByRole("button", { name: "Privacy Notice" }),
    screen.getByRole("button", { name: "Sign out" }),
  ]) {
    expect(control.className).toBe("secondary");
  }
});

test("the tool-call switch is off by default and is remembered in this browser", async () => {
  const values: Record<string, string> = {};
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
      removeItem: (key: string) => {
        delete values[key];
      },
    },
  });
  getAccount.mockResolvedValue(null);
  const { unmount } = render(<AccountPage />);
  const toggle = screen.getByRole("switch", { name: "Show tool calls" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(isTranscriptDebug()).toBe(false);

  await userEvent.click(toggle);
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  expect(isTranscriptDebug()).toBe(true);

  unmount();
  render(<AccountPage />);
  const again = screen.getByRole("switch", { name: "Show tool calls" });
  expect(again.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(again);
  expect(isTranscriptDebug()).toBe(false);
});

test("Account has no research mode switch; Show tool calls is the only one", async () => {
  getAccount.mockResolvedValue(null);
  render(<AccountPage />);
  await waitFor(() => expect(getAccount).toHaveBeenCalled());
  expect(screen.getAllByRole("switch").map((item) => item.getAttribute("aria-label"))).toEqual(["Show tool calls"]);
  expect(screen.queryByText(/research/i)).toBeNull();
});
