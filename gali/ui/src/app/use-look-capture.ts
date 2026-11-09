import { useCallback, useEffect, useRef, useState } from "react";
import { captureBrowserPage, captureErrorMessage, type WindowCapture } from "../features/voice/capture-page";
import type { LookCaptureResult } from "../realtime-client";

export function useLookCapture(input: {
  phone: boolean;
  connected: boolean;
  muted: boolean;
  setMicMuted: (muted: boolean) => void;
  setLookCapture: (handler: (() => Promise<LookCaptureResult>) | null) => void;
}) {
  const [capture, setCapture] = useState<WindowCapture | null>(null);
  const [phoneNotice, setPhoneNotice] = useState<string | null>(null);
  const resolveRef = useRef<((result: LookCaptureResult) => void) | null>(null);
  const muteRestoreRef = useRef<boolean | null>(null);
  const mutedRef = useRef(input.muted);
  mutedRef.current = input.muted;

  const finish = useCallback((result: LookCaptureResult) => {
    setCapture(null);
    if (muteRestoreRef.current !== null) {
      input.setMicMuted(muteRestoreRef.current);
      muteRestoreRef.current = null;
    }
    if (input.phone && result.status === "failed") setPhoneNotice(result.error);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(result);
  }, [input.phone, input.setMicMuted]);

  const begin = useCallback(async (): Promise<LookCaptureResult> => {
    if (input.phone) return { status: "failed", error: "Screen selection is not available on phone." };
    if (resolveRef.current) {
      const error = "A look selection is already open.";
      if (input.phone) setPhoneNotice(error);
      return { status: "failed", error };
    }
    try {
      muteRestoreRef.current = mutedRef.current;
      input.setMicMuted(true);
      const shot = await captureBrowserPage();
      setPhoneNotice(null);
      setCapture(shot);
      return await new Promise<LookCaptureResult>((resolve) => {
        resolveRef.current = resolve;
      });
    } catch (err) {
      if (muteRestoreRef.current !== null) {
        input.setMicMuted(muteRestoreRef.current);
        muteRestoreRef.current = null;
      }
      const error = captureErrorMessage(err);
      if (input.phone) setPhoneNotice(error);
      return { status: "failed", error };
    }
  }, [input.phone, input.setMicMuted]);

  useEffect(() => {
    input.setLookCapture(begin);
    return () => input.setLookCapture(null);
  }, [begin, input.setLookCapture]);

  useEffect(() => {
    if (!input.connected && capture) finish({ status: "cancelled" });
  }, [capture, finish, input.connected]);

  return { capture, phoneNotice, setPhoneNotice, finish };
}
