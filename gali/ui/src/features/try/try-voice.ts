import { writeGaliName } from "../../../../shared/domain/name-pronunciation";
import { connectRtcSession, type RtcSession } from "../../realtime/rtc-session";
import { endTryVoiceCall, extendTryVoiceCall, startTryVoiceCall, TryLimitError } from "./try-api";

const EXTEND_EVERY_MS = 60_000;

type FunctionCall = { type: "function_call"; call_id: string; name: string; arguments: string };

export type TryVoiceCallbacks = {
  onUserText: (text: string) => void;
  onAssistantText: (text: string) => void;
  onSpeaking: (speaking: boolean) => void;
  onTool: (name: string | null) => void;
  onEnded: (error: string | null) => void;
  onLimit: () => void;
  /** Answers quick_answer from the file in the browser. */
  answer: (question: string) => Promise<string>;
  turnPage: (target: { page?: number; direction?: "next" | "prev" }) => number;
};

function parseArgs(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw || "{}");
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** One realtime call for the no-login page. Tools run here, against the open file. */
export class TryVoice {
  private session: RtcSession | null = null;
  private audio: HTMLAudioElement | null = null;
  private handled = new Set<string>();
  private closed = false;
  private call: string | null = null;
  private extendTimer: number | null = null;
  private responding = false;
  private playing = false;
  private replyAfterCancel = false;

  constructor(private readonly cb: TryVoiceCallbacks) {}

  private readonly onPageHide = () => this.close(null);

  async connect(): Promise<void> {
    window.addEventListener("pagehide", this.onPageHide);
    this.audio = new Audio();
    this.audio.autoplay = true;
    const session = await connectRtcSession({
      exchange: async (offer) => {
        if (this.closed) throw new Error("voice was closed");
        const call = await startTryVoiceCall(offer);
        this.call = call.call;
        if (this.closed) endTryVoiceCall(call.call);
        else this.extendTimer = window.setInterval(() => void this.extend(call.call), EXTEND_EVERY_MS);
        return call.sdp;
      },
      mic: true,
      onMessage: (event) => void this.onEvent(event as Record<string, unknown>),
      onTrack: (stream) => {
        if (this.audio) this.audio.srcObject = stream;
      },
      onCreated: (created) => {
        this.session = created;
      },
      onConnected: () => {},
    }).finally(() => {
      if (this.closed) this.teardown();
    });
    session.pc.addEventListener("connectionstatechange", () => {
      if (session.pc.connectionState === "failed") {
        this.close("The voice connection dropped.");
      }
    });
  }

  /** A system note the model reads on its next turn; it never answers one by itself. */
  note(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "system", content: [{ type: "input_text", text }] },
    });
  }

  sendText(text: string): void {
    if (this.responding || this.playing) {
      this.send({ type: "response.cancel" });
      this.send({ type: "output_audio_buffer.clear" });
    }
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    if (this.responding) this.replyAfterCancel = true;
    else this.send({ type: "response.create" });
  }

  micStream(): MediaStream | null {
    return this.session?.mic ?? null;
  }

  remoteStream(): MediaStream | null {
    return (this.audio?.srcObject as MediaStream | null | undefined) ?? null;
  }

  setMuted(muted: boolean): void {
    for (const track of this.session?.mic?.getTracks() ?? []) track.enabled = !muted;
  }

  close(error: string | null = null): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener("pagehide", this.onPageHide);
    if (this.extendTimer !== null) window.clearInterval(this.extendTimer);
    if (this.call) endTryVoiceCall(this.call);
    this.teardown();
    this.cb.onSpeaking(false);
    this.cb.onEnded(error);
  }

  private async extend(call: string): Promise<void> {
    try {
      await extendTryVoiceCall(call);
    } catch (error) {
      if (this.closed) return;
      if (error instanceof TryLimitError) {
        this.close(null);
        this.cb.onLimit();
      } else if (error instanceof Error && error.message === "voice call has ended") {
        this.close("The voice session ended.");
      }
    }
  }

  private teardown(): void {
    const session = this.session;
    this.session = null;
    if (session) {
      for (const track of session.mic?.getTracks() ?? []) track.stop();
      session.dc.close();
      session.pc.close();
    }
    if (this.audio) this.audio.srcObject = null;
    this.audio = null;
  }

  private send(event: unknown): void {
    if (this.session?.dc.readyState !== "open") return;
    this.session.dc.send(JSON.stringify(event));
  }

  private async onEvent(event: Record<string, unknown>): Promise<void> {
    switch (event.type) {
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(event.transcript ?? "").trim();
        if (text) this.cb.onUserText(text);
        return;
      }
      case "response.output_audio_transcript.done": {
        const text = writeGaliName(String(event.transcript ?? "")).trim();
        if (text) this.cb.onAssistantText(text);
        return;
      }
      case "response.created":
        this.responding = true;
        return;
      case "output_audio_buffer.started":
        this.playing = true;
        this.cb.onSpeaking(true);
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        this.playing = false;
        this.cb.onSpeaking(false);
        return;
      case "error": {
        const error = event.error as { code?: unknown; message?: unknown } | undefined;
        if (error?.code === "session_expired") this.close("The voice session ended.");
        return;
      }
      case "response.done": {
        this.responding = false;
        const output = ((event.response as { output?: unknown[] } | undefined)?.output ?? []) as FunctionCall[];
        let reply = false;
        for (const item of output) {
          if (item.type !== "function_call" || this.handled.has(item.call_id)) continue;
          this.handled.add(item.call_id);
          this.cb.onTool(item.name);
          reply = (await this.runTool(item)) || reply;
          this.cb.onTool(null);
        }
        if (reply || this.replyAfterCancel) {
          this.replyAfterCancel = false;
          this.send({ type: "response.create" });
        }
        return;
      }
      default:
        return;
    }
  }

  /** Whether the model should speak after the tool's output. */
  private async runTool(call: FunctionCall): Promise<boolean> {
    const args = parseArgs(call.arguments);
    const output = (result: unknown) =>
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) },
      });
    switch (call.name) {
      case "quick_answer": {
        const question = String(args.question ?? "").trim();
        try {
          output({ answer: await this.cb.answer(question) });
        } catch (error) {
          output({ error: error instanceof Error ? error.message : String(error) });
        }
        return true;
      }
      case "set_viewer_page": {
        const direction = args.direction === "next" || args.direction === "prev" ? args.direction : undefined;
        const page = typeof args.page === "number" ? Math.trunc(args.page) : undefined;
        output({ page: this.cb.turnPage({ ...(page === undefined ? {} : { page }), ...(direction ? { direction } : {}) }) });
        return true;
      }
      case "end_voice":
        output({ ok: true });
        this.close(null);
        return false;
      default:
        output({ ok: true });
        return false;
    }
  }
}
