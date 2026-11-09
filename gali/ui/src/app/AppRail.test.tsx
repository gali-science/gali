import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { AppRail } from "./AppRail";

function railProps(overrides: Partial<Parameters<typeof AppRail>[0]> = {}) {
  return {
    selectedProjectKey: null,
    shellPage: "home" as const,
    chatOpen: false,
    connected: true,
    connecting: false,
    muted: false,
    onGoHome: vi.fn(),
    onToggleChat: vi.fn(),
    onToggleMute: vi.fn(),
    onToggleVoice: vi.fn(),
    ...overrides,
  };
}

test("the phone bar holds Library, Chat, mute and end voice, and nothing from the old desktop rail", () => {
  const props = railProps();
  render(<AppRail {...props} />);
  expect(screen.getAllByRole("button").map((button) => button.getAttribute("title"))).toEqual([
    "Library",
    "Chat",
    "Mute mic",
    "End voice",
  ]);
  expect(screen.queryByTitle("Select a region of the Gali window for Gali to see")).toBeNull();
  fireEvent.click(screen.getByTitle("Chat"));
  expect(props.onToggleChat).toHaveBeenCalledOnce();
  expect(screen.getByTitle("Chat").getAttribute("aria-pressed")).toBe("false");
  expect(document.querySelector(".rail-brand")).toBeNull();
});

test("the Chat button shows when the chat is open", () => {
  render(<AppRail {...railProps({ chatOpen: true })} />);
  expect(screen.getByTitle("Chat").getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByTitle("Chat").className).toContain("on");
});
