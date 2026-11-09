import {
  IconChat,
  IconHome,
  IconMic,
  IconMicOff,
  IconStopOutline,
} from "./icons";
import type { ShellPage } from "../navigation";

export function AppRail(props: {
  selectedProjectKey: string | null;
  shellPage: ShellPage;
  chatOpen: boolean;
  connected: boolean;
  connecting: boolean;
  muted: boolean;
  onGoHome: () => void;
  onToggleChat: () => void;
  onToggleMute: () => void;
  onToggleVoice: () => void;
}) {
  return (
    <aside className="rail">
      <button
        type="button"
        className={`rail-btn${props.selectedProjectKey === null && props.shellPage === "home" ? " on" : ""}`}
        onClick={props.onGoHome}
        title="Library"
      >
        <IconHome />
      </button>
      <button
        type="button"
        className={`rail-btn${props.chatOpen ? " on" : ""}`}
        aria-pressed={props.chatOpen}
        onClick={props.onToggleChat}
        title="Chat"
      >
        <IconChat />
      </button>
      <div className="rail-mic-slot" aria-hidden="true" />
      <button
        type="button"
        className={`rail-btn${props.muted ? " on" : ""}`}
        disabled={!props.connected}
        onClick={props.onToggleMute}
        title={props.muted ? "Unmute mic" : "Mute mic"}
      >
        {props.muted ? <IconMicOff /> : <IconMic />}
      </button>
      <button
        type="button"
        className={`rail-btn${props.connected || props.connecting ? " rail-stop-live" : ""}`}
        disabled={!props.connected && !props.connecting}
        onClick={props.onToggleVoice}
        title="End voice"
      >
        <IconStopOutline />
      </button>
    </aside>
  );
}
