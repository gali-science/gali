import { PillOrb } from "../features/voice/PillOrb";
import { IconMic } from "./icons";

export function AppVoiceBar(props: {
  phone: boolean;
  state: string;
  label: string;
  echo: string;
  chips: string[];
  reviewerBusy: boolean;
  talkChrome: boolean;
  connected: boolean;
  connecting: boolean;
  muted: boolean;
  error: string | null;
  outputLevel: number;
  toolPulse: number;
  trialBlocked: boolean;
  onSendChip: (chip: string) => void;
  onToggle: () => void;
  onClearError: () => void;
}) {
  return (
    <footer className={`voice-bar state-${props.state}${props.reviewerBusy ? " leo-busy" : ""}${props.phone ? "" : " voice-bar-island"}`}>
      {props.phone && (props.state === "listening" || props.reviewerBusy) && (
        <span className="voice-rim" aria-hidden="true" />
      )}
      {props.phone && (
        <div className="voice-pill" title={props.label}>
          <span className="voice-dot" />
        </div>
      )}
      {props.phone && (props.state === "listening" || props.reviewerBusy) && (
        <div className="voice-wave" aria-hidden="true">
          <span /><span /><span /><span /><span />
        </div>
      )}
      {props.phone && <div className="voice-echo">{props.echo}</div>}
      {props.phone && props.error && (
        <button type="button" className="voice-dismiss" onClick={props.onClearError}>
          ✕
        </button>
      )}
      {props.chips.length > 0 && (
        <div className="voice-chips">
          {props.chips.map((chip) => (
            <button
              key={chip}
              type="button"
              className="voice-chip"
              onClick={() => props.onSendChip(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
      )}
      {props.phone && (
        <div className="voice-actions">
          {props.talkChrome ? (
            <button
              type="button"
              className="voice-action primary-mic"
              disabled
              title="Talk"
            >
              <IconMic />
              <span>Talk</span>
            </button>
          ) : !props.connected && !props.connecting ? (
            <button
              type="button"
              className="voice-action primary-mic"
              onClick={props.onToggle}
              disabled={props.trialBlocked}
              title="Start voice (Ctrl+Space)"
            >
              <IconMic />
              <span>Talk</span>
            </button>
          ) : props.connecting ? (
            <button
              type="button"
              className="voice-action primary-mic is-connecting"
              disabled
              title="Connecting"
            >
              <IconMic />
              <span>Connecting…</span>
            </button>
          ) : (
            <div
              className={`voice-action orb-live${props.muted ? " is-muted" : ""}`}
              role="status"
              aria-label={props.muted ? "Voice live, mic muted" : "Voice live"}
              title={props.muted ? "Mic muted" : "Gali is live"}
            >
              <PillOrb
                state={props.muted ? "idle" : props.outputLevel > 0.04 ? "talking" : "listening"}
                volume={props.outputLevel}
                toolPulse={props.toolPulse}
                centered
              />
            </div>
          )}
        </div>
      )}
    </footer>
  );
}
