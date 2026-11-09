import { useCallback, useEffect, useRef, useState } from "react";
import type { WakeProgressPhase } from "../../../shared/sandbox-health";
import { usePlatform } from "../platform/context";
import { bootTrace, bootTraceText } from "./boot-trace";

const BOOT_MIN_MS = 2500;
const STUCK_WAKING_MS = 90_000;
const BOOT_FADE_MS = 420;

export type BackendState = "waking" | "ready" | "error" | "locked";
export type BootPhase = "booting" | "fading" | "done";

export function useBootSequence(input: {
  authLoaded: boolean;
  isSignedIn: boolean;
  load: () => Promise<void>;
}) {
  const platform = usePlatform();
  const wakesSandbox = platform.capabilities.sandboxWake;
  const [loading, setLoading] = useState(true);
  const [backend, setBackend] = useState<BackendState>(wakesSandbox ? "waking" : "ready");
  const [backendError, setBackendError] = useState<string | null>(null);
  const [wakePhase, setWakePhase] = useState<WakeProgressPhase | null>(null);
  const [bootKey, setBootKey] = useState(0);
  const [bootPhase, setBootPhase] = useState<BootPhase>("booting");
  const bootStartedAt = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (wakesSandbox) {
        bootTrace(`boot run: authLoaded=${input.authLoaded} signedIn=${input.isSignedIn}`);
        if (!input.authLoaded) return;
        if (!input.isSignedIn) {
          setBackend("locked");
          setBackendError(null);
          setLoading(false);
          setBootPhase("booting");
          return;
        }
        setBackend("waking");
        setWakePhase(null);
        try {
          await platform.boot.ensureReady((phase) => {
            if (!cancelled) setWakePhase(phase);
          });
          bootTrace(cancelled ? "boot run: ready, but this run was cancelled" : "boot run: ready");
          if (!cancelled) {
            setBackend("ready");
            setBackendError(null);
          }
        } catch (err) {
          bootTrace(`boot run: failed${cancelled ? " (cancelled)" : ""}: ${err instanceof Error ? err.message : String(err)}`);
          if (!cancelled) {
            setBackend(platform.boot.isAuthRequired(err) ? "locked" : "error");
            setBackendError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          }
          return;
        }
      }
      try {
        await input.load();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      bootTrace("boot run: cancelled");
    };
  }, [input.authLoaded, input.isSignedIn, input.load, bootKey, platform, wakesSandbox]);

  useEffect(() => {
    if (backend !== "waking") return;
    const timer = window.setTimeout(() => {
      const trace = bootTraceText();
      console.warn(`[boot] still waking after ${STUCK_WAKING_MS / 1000}s: ${trace}`);
      // The log endpoint rejects messages over 500 characters; the latest steps are the useful ones.
      const error = new Error(`still waking: …${trace.slice(-440)}`);
      void platform.reportError("boot_stuck_waking", error).catch(() => {});
    }, STUCK_WAKING_MS);
    return () => window.clearTimeout(timer);
  }, [backend, platform]);

  const bootReady = backend === "ready" && !loading;
  useEffect(() => {
    if (!bootReady || bootPhase !== "booting") return;
    const hold = Math.max(0, BOOT_MIN_MS - (Date.now() - bootStartedAt.current));
    const timer = window.setTimeout(() => setBootPhase("fading"), hold);
    return () => window.clearTimeout(timer);
  }, [bootReady, bootPhase]);

  useEffect(() => {
    if (bootPhase !== "fading") return;
    const timer = window.setTimeout(() => setBootPhase("done"), BOOT_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [bootPhase]);

  const retryBoot = useCallback(() => {
    setBackendError(null);
    setLoading(true);
    setBackend(wakesSandbox ? "waking" : "ready");
    bootStartedAt.current = Date.now();
    setBootKey((key) => key + 1);
  }, [wakesSandbox]);

  return { backend, backendError, bootPhase, wakePhase, retryBoot };
}
