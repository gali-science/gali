import { useCallback, useEffect, useState } from "react";

const DEBUG_KEY = "gali.transcript.debug";
const DEBUG_EVENT = "gali:transcript-debug";

export function isTranscriptDebug(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    return false;
  }
}

export function setTranscriptDebug(on: boolean): void {
  try {
    if (on) localStorage.setItem(DEBUG_KEY, "1");
    else localStorage.removeItem(DEBUG_KEY);
  } catch {
  }
  window.dispatchEvent(new Event(DEBUG_EVENT));
}

export function useTranscriptDebug(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(isTranscriptDebug);
  useEffect(() => {
    const sync = () => setOn(isTranscriptDebug());
    window.addEventListener(DEBUG_EVENT, sync);
    return () => window.removeEventListener(DEBUG_EVENT, sync);
  }, []);
  const update = useCallback((next: boolean) => {
    setTranscriptDebug(next);
    setOn(next);
  }, []);
  return [on, update];
}
