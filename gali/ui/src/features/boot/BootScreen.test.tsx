import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { BootScreen } from "./BootScreen";

test("a wake that installs an update says so", () => {
  render(<BootScreen state="waking" wakePhase="updating" error={null} onRetry={() => {}} />);
  expect(screen.getByRole("status").textContent).toContain("there’s a new update! installing it");
});

test("a wake starting the server says so", () => {
  render(<BootScreen state="waking" wakePhase="starting" error={null} onRetry={() => {}} />);
  expect(screen.getByRole("status").textContent).toBe("starting Gali…");
});
