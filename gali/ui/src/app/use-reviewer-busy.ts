import { useEffect, useMemo, useState } from "react";
import { onBackendRestart, onReviewerEvent } from "../api";

/** Questions queued or running on the reviewer, plus a running background review, per project. */
export function useReviewerBusy(): Record<string, number> {
  const [turns, setTurns] = useState<Record<string, number>>({});
  const [reviewing, setReviewing] = useState<Record<string, boolean>>({});
  useEffect(() => onReviewerEvent((event) => {
    if (event.type === "reviewer.reviewing") {
      setReviewing((current) => ({ ...current, [event.projectKey]: event.running }));
      return;
    }
    setTurns((current) => {
      const count = current[event.projectKey] ?? 0;
      const next = event.type === "reviewer.started" ? count + 1 : Math.max(0, count - 1);
      return { ...current, [event.projectKey]: next };
    });
  }), []);
  // A restart kills the reviewer mid-turn, so its "finished" events never come.
  useEffect(() => onBackendRestart(() => {
    setTurns({});
    setReviewing({});
  }), []);
  return useMemo(() => {
    const busy = { ...turns };
    for (const [projectKey, running] of Object.entries(reviewing)) {
      if (running) busy[projectKey] = (busy[projectKey] ?? 0) + 1;
    }
    return busy;
  }, [turns, reviewing]);
}
