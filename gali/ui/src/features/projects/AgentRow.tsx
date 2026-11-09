import { useEffect, useState } from "react";
import type { ReviewProgressDto, ReviewProgressEvent } from "../../../../shared/domain/contracts";
import { cancelReview, getReviewProgress, onReviewProgress } from "../../api";

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function merge(run: ReviewProgressDto, events: ReviewProgressEvent[]): ReviewProgressDto {
  if (!run || events.length === 0) return run;
  const entryAt = new Set(run.entries.map((entry) => entry.at));
  const entries = [...run.entries];
  for (const event of events) {
    if (!("entry" in event) || entryAt.has(event.entry.at)) continue;
    entryAt.add(event.entry.at);
    entries.push(event.entry);
  }
  return { ...run, entries: entries.sort((a, b) => a.at - b.at) };
}

// Kept across remounts so switching tabs shows the run at once; the snapshot then catches up.
const runCache = new Map<string, ReviewProgressDto>();

/** The agent's current run (or its last one): the snapshot first, then each line as it arrives. */
export function useAgentRun(projectKey: string, busy: boolean): ReviewProgressDto {
  const [run, setRun] = useState<ReviewProgressDto>(() => runCache.get(projectKey) ?? null);
  useEffect(() => {
    setRun(runCache.get(projectKey) ?? null);
    let live = true;
    let loaded = false;
    const early: ReviewProgressEvent[] = [];
    const update = (next: ReviewProgressDto) => {
      runCache.set(projectKey, next);
      setRun(next);
    };
    const off = onReviewProgress((event) => {
      if (event.projectKey !== projectKey) return;
      if (!loaded) early.push(event);
      else update(merge(runCache.get(projectKey) ?? null, [event]));
    });
    void getReviewProgress(projectKey).then((snapshot) => {
      if (!live) return;
      loaded = true;
      update(merge(snapshot, early));
    }, (error: unknown) => console.error("[agent-run]", error));
    return () => {
      live = false;
      off();
    };
  }, [projectKey, busy]);
  return run;
}

function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return now;
}

export function AgentRow({ projectKey, run }: { projectKey: string; run: ReviewProgressDto }) {
  const working = run !== null && run.finishedAt === null ? run : null;
  const now = useNow(working !== null);
  const [stopping, setStopping] = useState(false);
  return (
    <div className="agent-row is-live">
      <div className="agent-row-card">
        <div className="agent-row-main">
          <span className="agent-row-light" role="img" aria-label="Agent working" />
          <span className="agent-row-text" role="status">{stopping ? "Stopping…" : working?.entries.at(-1)?.text ?? "Getting started"}</span>
          {working ? <time>{clock(now - working.startedAt)}</time> : null}
        </div>
        {working ? (
          <button
            type="button"
            className="panel-action is-stop"
            disabled={stopping}
            onClick={() => {
              setStopping(true);
              void cancelReview(projectKey);
            }}
          >
            {stopping ? "Stopping…" : "Stop"}
          </button>
        ) : null}
      </div>
    </div>
  );
}