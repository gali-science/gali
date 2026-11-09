import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const getAccount = vi.fn();

vi.mock("./account", () => ({
  TRIAL_UPDATED_EVENT: "gali:trial-updated",
  getAccount: (...args: unknown[]) => getAccount(...args),
  flushTrialUsageQueue: vi.fn().mockResolvedValue(null),
  setTrialUsageScope: vi.fn(),
}));

const { useTrial } = await import("./useTrial");

beforeEach(() => {
  getAccount.mockReset();
});

test("an exhausted trial blocks access", async () => {
  getAccount.mockResolvedValue({
    identityEmail: "user@example.com",
    trial: {
      status: "exhausted",
      spentUsd: 10,
      budgetUsd: 10,
      remainingUsd: 0,
    },
  });
  const { result } = renderHook(() => useTrial({ enabled: true, polling: false }));
  await waitFor(() => expect(result.current.accessBlocked).toBe(true));
  expect(result.current.trialExhausted).toBe(true);
});

test("keeps polling after an account request fails", async () => {
  getAccount.mockRejectedValue(new Error("account unavailable"));
  const interval = vi.spyOn(window, "setInterval");
  const { unmount } = renderHook(() =>
    useTrial({ enabled: true, polling: true }),
  );
  await waitFor(() => expect(getAccount).toHaveBeenCalled());
  expect(interval).toHaveBeenCalled();
  unmount();
  interval.mockRestore();
});

test("does not let an older account response undo exhaustion", async () => {
  let resolveOlder!: (value: unknown) => void;
  let resolveNewer!: (value: unknown) => void;
  getAccount
    .mockReturnValueOnce(new Promise((resolve) => {
      resolveOlder = resolve;
    }))
    .mockReturnValueOnce(new Promise((resolve) => {
      resolveNewer = resolve;
    }));
  const { result } = renderHook(() =>
    useTrial({ enabled: true, polling: false }),
  );
  await waitFor(() => expect(getAccount).toHaveBeenCalledTimes(1));
  let refresh!: Promise<void>;
  act(() => {
    refresh = result.current.refreshTrial();
  });
  resolveNewer({
    identityEmail: "user@example.com",
    trial: {
      status: "exhausted",
      spentUsd: 10,
      budgetUsd: 10,
      remainingUsd: 0,
    },
  });
  await refresh;
  resolveOlder({
    identityEmail: "user@example.com",
    trial: {
      status: "active",
      spentUsd: 9,
      budgetUsd: 10,
      remainingUsd: 1,
    },
  });
  await waitFor(() => expect(result.current.trial?.status).toBe("exhausted"));
});
