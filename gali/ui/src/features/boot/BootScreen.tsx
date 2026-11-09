import { useEffect, useState } from "react";
import type { WakeProgressPhase } from "../../../../shared/sandbox-health";

const SLOW_WAKE_MS = 6000;

export type BootState = "waking" | "loading" | "error";

export function BootScreen({
  state,
  wakePhase = null,
  error,
  onRetry,
  leaving = false,
}: {
  state: BootState;
  wakePhase?: WakeProgressPhase | null;
  error: string | null;
  onRetry: () => void;
  leaving?: boolean;
}) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (state !== "waking") {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_WAKE_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <section
      className={`roster-pane is-empty boot-pane${leaving ? " is-leaving" : ""}`}
      aria-hidden={leaving}
    >
      <div className="book home-book is-empty">
        <div className="home-empty home-empty-centered">
          <i
            className={`fa-solid fa-circle-half-stroke home-empty-mark${
              state === "error" ? "" : " boot-mark-waking"
            }`}
            aria-hidden="true"
          />
          <header className="home-hero home-empty-hero">
            <h1 className="home-title home-empty-title">Gali</h1>
          </header>

          {state === "error" ? (
            <div className="boot-failed" role="alert">
              <p className="boot-failed-line">couldn’t wake Gali</p>
              {error ? <p className="boot-failed-detail">{error}</p> : null}
              <button type="button" className="secondary boot-retry" onClick={onRetry}>
                Try again
              </button>
            </div>
          ) : (
            <div className="boot-waiting">
              <div className="boot-progress" aria-hidden="true">
                <div />
              </div>
              <p className="home-empty-hint" role="status">
                {state === "loading"
                  ? "loading projects…"
                  : wakePhase === "updating"
                    ? "there’s a new update! installing it — this can take a minute or two"
                    : wakePhase === "starting"
                      ? "starting Gali…"
                      : slow
                        ? "still waking — resuming a paused sandbox takes a few seconds"
                        : "waking Gali…"}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
