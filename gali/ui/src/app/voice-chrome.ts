import type { ProjectDto } from "../api";

export type VoiceChromeState = "idle" | "error" | "connecting" | "muted" | "listening";

type VoiceChromeInput = {
  talkChrome: boolean;
  error: string | null;
  connecting: boolean;
  connected: boolean;
  muted: boolean;
  pendingTool: string | null;
  lines: Array<
    | { kind: "message"; text: string }
    | { kind: "tool" | "status" }
  >;
  reviewerBusy: boolean;
  trialBlocked: boolean;
  selectedProjectKey: string | null;
  projects: ProjectDto[];
};

export function deriveVoiceChrome(input: VoiceChromeInput) {
  const state: VoiceChromeState = input.talkChrome
    ? "idle"
    : input.error
      ? "error"
      : input.connecting
        ? "connecting"
        : input.connected
          ? input.muted ? "muted" : "listening"
          : "idle";
  const label = input.talkChrome
    ? "Talk"
    : state === "error"
      ? "Error"
      : state === "connecting"
        ? "Connecting"
        : input.reviewerBusy
          ? "Working"
          : state === "muted"
            ? "Muted"
            : state === "listening" ? "Listening" : "Ready";
  const lastHeard = [...input.lines].reverse().find((line) => line.kind === "message");
  const idleEcho = "Talk to Gali — open a PDF, ask about a figure, or have Gali check the code.";
  const echo = input.error
    ? input.error
    : input.talkChrome
      ? idleEcho
      : input.pendingTool === "ask_reviewer"
        ? "Asked Gali — the answer comes when it is done."
        : lastHeard?.kind === "message"
          ? lastHeard.text
          : input.connected
            ? "Listening — name a PDF, or ask a question about it."
            : idleEcho;
  let chips: string[] = [];
  if (
    !input.trialBlocked
    && !input.talkChrome
    && !input.error
    && !input.connecting
  ) {
    if (input.selectedProjectKey) {
      chips = ["Summarize this PDF", "Does the code match the method?", "Highlight the main claim"];
    } else {
      const latest = [...input.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      chips = [
        ...(latest ? [`Open ${latest.title}`] : []),
        "Add a PDF",
      ];
    }
  }
  return { state, label, echo, chips };
}
