import { useEffect, useRef, useState, type FormEvent } from "react";
import { IconLook } from "../../app/icons";
import { PillOrb, type PillOrbState } from "./PillOrb";

type Props = {
  connected: boolean;
  connecting: boolean;
  muted: boolean;
  error: string | null;
  inputLevel: number;
  outputLevel: number;
  pendingTool?: string | null;
  toolPulse: number;
  pinned?: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onMute: () => void;
  onClearError: () => void;
  onSend?: (text: string) => Promise<void>;
  onLook?: () => void;
  lookDisabled?: boolean;
};

const TALK_HOLD_MS = 1200;
const LISTEN_HOLD_MS = 1000;
const LABEL_MIN_MS = 1400;
const IDLE_COLLAPSE_MS = 2000;
const PENDING_CHIP_DELAY_MS = 600;

function rawPillState(
  connecting: boolean,
  connected: boolean,
  muted: boolean,
  inputLevel: number,
  outputLevel: number,
): PillOrbState {
  if (connecting || !connected || muted) return "idle";
  if (outputLevel > 0.04) return "talking";
  if (inputLevel > 0.05) return "listening";
  return "idle";
}

function islandPhase(
  connecting: boolean,
  connected: boolean,
  muted: boolean,
  error: string | null,
  state: PillOrbState,
  waiting: boolean,
): "idle" | "hear" | "think" | "speak" | "muted" | "error" | "connecting" | "wait" {
  if (error) return "error";
  if (connecting) return "connecting";
  if (!connected) return "idle";
  if (waiting) return "wait";
  if (muted) return "muted";
  if (state === "talking") return "speak";
  if (state === "listening") return "hear";
  return "idle";
}

function stateLabel(
  phase: ReturnType<typeof islandPhase>,
  connected: boolean,
): string {
  if (phase === "error") return "Error";
  if (phase === "connecting") return "Connecting";
  if (!connected) return "Talk";
  if (phase === "wait") return "Waiting";
  if (phase === "muted") return "Muted";
  if (phase === "speak") return "Speaking";
  if (phase === "hear") return "Listening";
  return "Ready";
}

const PENDING_TOOL_LABELS = new Map([
  ["ask_reviewer", "Looking into it"],
  ["quick_answer", "Looking up"],
  ["project_source", "Reading files"],
  ["delete_project", "Deleting"],
]);

function pendingChipText(name: string): string {
  return PENDING_TOOL_LABELS.get(name) ?? "Working on it";
}

function useDelayedPendingTool(pendingTool: string | null): string | null {
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    setShown(null);
    if (!pendingTool) return;
    const timer = window.setTimeout(() => setShown(pendingTool), PENDING_CHIP_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pendingTool]);
  return pendingTool ? shown : null;
}

function useHeldPillState(
  connecting: boolean,
  connected: boolean,
  muted: boolean,
  inputLevel: number,
  outputLevel: number,
): PillOrbState {
  const [held, setHeld] = useState<PillOrbState>("idle");
  const lastTalkAt = useRef(0);
  const lastListenAt = useRef(0);

  useEffect(() => {
    let raf = 0;
    let alive = true;
    const tick = (now: number) => {
      if (!alive) return;
      const raw = rawPillState(connecting, connected, muted, inputLevel, outputLevel);
      if (raw === "talking") lastTalkAt.current = now;
      if (raw === "listening") lastListenAt.current = now;

      let next: PillOrbState = "idle";
      if (connecting || !connected || muted) {
        next = "idle";
      } else if (
        outputLevel > 0.04
        || (lastTalkAt.current > 0 && now - lastTalkAt.current < TALK_HOLD_MS)
      ) {
        next = "talking";
      } else if (
        inputLevel > 0.05
        || (lastListenAt.current > 0 && now - lastListenAt.current < LISTEN_HOLD_MS)
      ) {
        next = "listening";
      }

      setHeld((prev) => (prev === next ? prev : next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
    };
  }, [connecting, connected, muted, inputLevel, outputLevel]);

  return held;
}

function useHeldLabel(next: string): string {
  const [label, setLabel] = useState(next);
  const shownAt = useRef(performance.now());
  const pending = useRef<string | null>(null);

  useEffect(() => {
    if (next === label) {
      pending.current = null;
      return;
    }
    const elapsed = performance.now() - shownAt.current;
    if (next === "Muted" || label === "Muted" || next === "Connecting" || elapsed >= LABEL_MIN_MS) {
      shownAt.current = performance.now();
      pending.current = null;
      setLabel(next);
      return;
    }
    pending.current = next;
    const wait = LABEL_MIN_MS - elapsed;
    const timer = window.setTimeout(() => {
      if (pending.current == null) return;
      shownAt.current = performance.now();
      setLabel(pending.current);
      pending.current = null;
    }, wait);
    return () => window.clearTimeout(timer);
  }, [next, label]);

  return label;
}

export function VoiceIsland({
  connected,
  connecting,
  muted,
  error,
  inputLevel,
  outputLevel,
  pendingTool = null,
  toolPulse,
  pinned = false,
  disabled = false,
  onToggle,
  onMute,
  onClearError,
  onSend,
  onLook,
  lookDisabled = false,
}: Props) {
  const [draft, setDraft] = useState("");
  const state = useHeldPillState(connecting, connected, muted, inputLevel, outputLevel);
  const waitingTool = useDelayedPendingTool(pendingTool);
  const waitLabel = waitingTool !== null ? pendingChipText(waitingTool) : null;
  const phase = islandPhase(connecting, connected, muted, error, state, waitLabel !== null);
  const speaking = phase === "speak";
  const held = useHeldLabel(stateLabel(phase === "wait" ? islandPhase(connecting, connected, muted, error, state, false) : phase, connected));
  const label = waitLabel ?? held;
  const busy = waitLabel !== null;
  const docked = onSend !== undefined;
  const typing = docked && !connecting && !error;
  const hasDraft = draft.trim().length > 0;
  const collapseEligible = !pinned && !docked && !busy && outputLevel <= 0.04 && (phase === "idle" || phase === "muted");
  const [shrunk, setShrunk] = useState(false);

  useEffect(() => {
    if (!collapseEligible) {
      setShrunk(false);
      return;
    }
    const timer = window.setTimeout(() => setShrunk(true), IDLE_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [collapseEligible]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !onSend || connecting) return;
    void onSend(text).then(() => setDraft(""), () => {});
  };

  const Row = docked ? "form" : "div";

  return (
    <div
      className={`voice-island${docked ? " is-docked" : ""}`}
      data-phase={phase}
      data-size={shrunk && collapseEligible ? "min" : "full"}
      data-wait={busy ? "on" : undefined}
    >
      <div className="voice-island-capsule" role="group" aria-label="Gali voice">
        <PillOrb state={state} volume={outputLevel} toolPulse={toolPulse} />

        <Row className="voice-island-row" onSubmit={docked ? submit : undefined} autoComplete={docked ? "off" : undefined}>
          <div className="voice-island-orb-slot" aria-hidden="true" />
          <div className="voice-island-mid">
            {docked && !error ? (
              <input
                className="voice-island-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Ask Gali about this PDF…"
                aria-label="Ask Gali"
              />
            ) : null}
            {typing && (!connected || hasDraft) ? null : (
              <span
                className="voice-island-state"
                role={waitLabel ? "status" : undefined}
                aria-live={waitLabel ? "polite" : undefined}
              >
                {label}
              </span>
            )}
          </div>
          <div className="voice-island-controls">
            {docked && onLook ? (
              <button
                type="button"
                className="voice-island-ctl voice-island-look"
                title="Look · point at something on screen"
                aria-label="Look"
                onClick={onLook}
                disabled={lookDisabled}
              >
                <IconLook />
              </button>
            ) : null}
            {error ? (
              <button
                type="button"
                className="voice-island-ctl is-error"
                title="Dismiss error"
                onClick={onClearError}
              >
                ✕
              </button>
            ) : null}

            {typing && hasDraft ? (
              <button type="submit" className="voice-island-ctl is-go" title="Send">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 19V5M5.5 11.5 12 5l6.5 6.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : null}
            {typing && hasDraft && !connected ? null : !connected && !connecting ? (
              <button
                type="button"
                className="voice-island-ctl is-go"
                title="Start voice (Ctrl+Space)"
                onClick={onToggle}
                disabled={disabled}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M9.5 7.2 16.4 12l-6.9 4.8Z"
                    fill="currentColor"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={`voice-island-ctl${muted ? " is-muted" : ""}`}
                  title={muted ? "Unmute mic (Ctrl+M)" : "Mute mic (Ctrl+M)"}
                  onClick={onMute}
                  disabled={connecting}
                >
                  {muted ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
                        stroke="currentColor"
                        strokeWidth="1.8"
                      />
                      <path
                        d="M7 11a5 5 0 0 0 10 0M12 16v3M9 19h6M4 4l16 16"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                      <path
                        d="M12 3a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"
                        stroke="currentColor"
                        strokeWidth="1.8"
                      />
                      <path
                        d="M7 11a5 5 0 0 0 10 0M12 16v3M9 19h6"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </button>
                {connecting ? (
                  <button type="button" className="voice-island-ctl" disabled title="Connecting">
                    …
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`voice-island-ctl${speaking ? " is-stop" : ""}`}
                    title="End voice (Ctrl+Space)"
                    onClick={onToggle}
                  >
                    <span className="voice-island-stop" aria-hidden="true" />
                  </button>
                )}
              </>
            )}
          </div>
        </Row>
      </div>
    </div>
  );
}
