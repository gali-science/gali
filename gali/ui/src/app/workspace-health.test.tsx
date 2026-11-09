import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { PlatformProvider } from "../platform/context";
import type { Platform } from "../platform/runtime";
import {
  createWorkspaceHealthMonitor,
  WorkspaceUnavailableError,
} from "../workspace-health";
import { WorkspaceHealthBanner, WorkspaceHealthProvider } from "./workspace-health";

const failure = {
  kind: "start_failed",
  provider: "vercel",
  detail: "sandbox b is failed_to_start (internal_error)",
} as const;

function renderBanner(ensureReady: () => Promise<{ status: string }>, onRecovered = vi.fn()) {
  const health = createWorkspaceHealthMonitor();
  const platform = { workspace: health, boot: { ensureReady } } as unknown as Platform;
  render(
    <PlatformProvider platform={platform}>
      <WorkspaceHealthProvider>
        <WorkspaceHealthBanner onRecovered={onRecovered} />
      </WorkspaceHealthProvider>
    </PlatformProvider>,
  );
  return { health, onRecovered };
}

test("nothing shows while the workspace is reachable or only reconnecting", () => {
  const { health } = renderBanner(vi.fn());
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => health.lost());
  expect(screen.queryByRole("alert")).toBeNull();
});

test("an unavailable workspace shows the reason in plain words and the provider's own", () => {
  const { health } = renderBanner(vi.fn());
  act(() => health.unavailable(failure));

  expect(screen.getByText("Your workspace failed to start.")).toBeTruthy();
  expect(screen.getByText("Vercel: sandbox b is failed_to_start (internal_error)")).toBeTruthy();
});

test("retry wakes the workspace and hands control back once it answers", async () => {
  const ensureReady = vi.fn(async () => {
    health.reached();
    return { status: "ready" };
  });
  const onRecovered = vi.fn();
  const { health } = renderBanner(ensureReady, onRecovered);
  act(() => health.unavailable(failure));

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(ensureReady).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(onRecovered).toHaveBeenCalledOnce());
});

test("a retry that fails for another reason says so in the banner", async () => {
  const { health } = renderBanner(vi.fn(async () => {
    throw new Error("sandbox request failed");
  }));
  act(() => health.unavailable(failure));

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  await vi.waitFor(() => expect(screen.getByText("sandbox request failed")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

test("a retry that fails the same typed way keeps the provider's reason", async () => {
  const { health } = renderBanner(vi.fn(async () => {
    throw new WorkspaceUnavailableError(failure);
  }));
  act(() => health.unavailable(failure));

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));

  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy());
  expect(screen.getByText("Vercel: sandbox b is failed_to_start (internal_error)")).toBeTruthy();
});
