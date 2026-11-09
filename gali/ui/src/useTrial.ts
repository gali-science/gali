import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  flushTrialUsageQueue,
  getAccount,
  setTrialUsageScope,
  TRIAL_UPDATED_EVENT,
  type TrialStatusDto,
} from "./account";

export function useTrial(input: {
  enabled: boolean;
  polling: boolean;
}) {
  const [trial, setTrial] = useState<TrialStatusDto | null>(null);
  const trialRequest = useRef(0);
  const identity = useRef<string | null>(null);

  const refreshTrial = useCallback(async () => {
    const request = ++trialRequest.current;
    if (!input.enabled) {
      identity.current = null;
      setTrialUsageScope(null);
      setTrial(null);
      return;
    }
    try {
      const account = await getAccount();
      if (request !== trialRequest.current) return;
      if (!account) {
        identity.current = null;
        setTrialUsageScope(null);
        setTrial(null);
        return;
      }
      const nextIdentity = account.identityEmail.trim().toLowerCase();
      const changedAccount = identity.current !== null && identity.current !== nextIdentity;
      identity.current = nextIdentity;
      setTrialUsageScope(nextIdentity);
      setTrial((current) =>
        !changedAccount && current?.status === "exhausted" && account.trial.status === "active"
          ? current
          : account.trial
      );
      void flushTrialUsageQueue().catch(() => {});
    } catch {
    }
  }, [input.enabled]);

  useEffect(() => {
    void refreshTrial();
  }, [refreshTrial]);

  useEffect(() => {
    if (!input.enabled) return;
    void flushTrialUsageQueue().catch(() => {});
  }, [input.enabled]);

  useEffect(() => {
    const onUpdated = (event: Event) => {
      const detail = (event as CustomEvent<TrialStatusDto>).detail;
      if (detail?.status === "active" || detail?.status === "exhausted") {
        trialRequest.current += 1;
        setTrial((current) =>
          current?.status === "exhausted" && detail.status === "active"
            ? current
            : detail
        );
      }
    };
    window.addEventListener(TRIAL_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(TRIAL_UPDATED_EVENT, onUpdated);
  }, []);

  useEffect(() => {
    if (!input.enabled || !input.polling) return;
    const timer = window.setInterval(() => {
      void refreshTrial();
      void flushTrialUsageQueue().catch(() => {});
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [input.enabled, input.polling, refreshTrial]);

  const trialExhausted = trial?.status === "exhausted";

  return useMemo(
    () => ({
      trial,
      trialExhausted,
      accessBlocked: trialExhausted,
      refreshTrial,
    }),
    [refreshTrial, trial, trialExhausted],
  );
}
