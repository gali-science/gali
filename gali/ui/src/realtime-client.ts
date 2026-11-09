import { writeGaliName } from "../../shared/domain/name-pronunciation";
import type { VoiceMemoryDto } from "../../shared/domain/contracts";
import { reportTrialUsage } from "./account";
import { mintRealtimeToken, onReviewerEvent, type ReviewerEvent } from "./api";
import { canDownload } from "./downloads";
import { fetchHostedVoiceMemory } from "./voice-memory";
import { AnnouncementQueue } from "./realtime/announcement-queue";
import { MEMORY_MAX_AGE_MS } from "./realtime/memory";
import { formatAgo, parseToolArguments } from "./realtime/pure-helpers";
import {
  ephemeralKeyFromToken,
  turnDetectionFromToken,
  type RealtimeTurnDetection,
} from "./realtime/rtc-connection";
import { connectRtcSession } from "./realtime/rtc-session";
import { isActiveResponseError, type RealtimeServerEvent } from "./realtime/server-event";
import { isAutoplayBlocked, UNMUTE_HOLD_MS } from "./realtime/speech-control";
import {
  AttachedView,
  readOpenTilePage,
  readOpenTileVisual,
  type LookCaptureResult,
  type TileCaptureHandler,
  type TileCaptureTarget,
} from "./realtime/tile-view-sync";
import { anchorNoteToViewer, RealtimeToolDispatcher } from "./realtime/tool-running";

export type {
  LookCaptureResult,
  TileCaptureHandler,
  TileCaptureTarget,
} from "./realtime/tile-view-sync";

export type ChatRole = "user" | "assistant" | "tool" | "system";

export type StatusMark =
  | { type: "reviewer"; phase: "started" | "background" | "finished" | "failed" | "stopped" }
  | { type: "view-shared" };

export type StatusEvent = { kind: "status"; text: string; projectKey?: string; mark?: StatusMark };

export type ChatEvent =
  | { kind: "message"; role: ChatRole; text: string; projectKey?: string }
  | { kind: "tool"; name: string; args: unknown; result: unknown }
  | { kind: "tool_call"; name: string }
  | StatusEvent;

type LookHandler = () => Promise<LookCaptureResult>;

type Callbacks = {
  onEvent: (e: ChatEvent) => void;
  onConnected?: (connected: boolean) => void;
  onAudioBlocked?: (blocked: boolean) => void;
  onMetered?: (metered: boolean) => void;
  onDropped?: (drop: { reason: string; lastedMs: number }) => void;
};

type FunctionCallItem = { type: string; name: string; call_id: string; arguments?: string };

const LOOK_PROMPT =
  "The user selected this region of the Gali window for you to look at. Explain what they pointed at.";

const REVIEWER_ANSWER_CHARS = 4_000;

function reviewerSpeech(event: ReviewerEvent, question: string | undefined, project: string): string {
  const asked = question ? ` The question was: "${question}".` : "";
  if (event.type !== "reviewer.finished" || event.status === "cancelled") return "";
  if (event.status === "failed") {
    return `Your earlier check could not finish on project "${project}".${asked} The error was: ${event.error}. Tell the user in one short sentence, naming the project in a few words if it is not the one they have open, and offer to ask again.`;
  }
  const answer = event.message.length > REVIEWER_ANSWER_CHARS
    ? `${event.message.slice(0, REVIEWER_ANSWER_CHARS)}…`
    : event.message;
  return `Your earlier check finished on project "${project}".${asked} The answer: ${answer}\nGive the user the answer in your own spoken words, never longer than the answer and at most four sentences. If that project is not the one the user has open, name it in a few words first. If it only says the work started or is still running, say so in one short sentence. Mention a review file only if the answer names one. Do not read file paths character by character.`;
}

export class VoiceScientist {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private connectedAt = 0;
  private tearingDown = false;
  private mic: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private audioBlocked = false;
  private trialMetered = false;
  private handledCalls = new Set<string>();
  private unsubscribeReviewer: (() => void) | null = null;
  private reviewerQuestions = new Map<string, string[]>();
  private muted = false;
  private voice = true;
  private unmuteIgnoreUntil = 0;
  private muteEpoch = 0;
  private lookHandler: LookHandler | null = null;
  private readonly view: AttachedView;
  private toolResponsePending = false;
  private toolResponseRetry = false;
  private activeResponses = 0;
  private typedReplyPending = false;
  private toolCallsInFlight = 0;
  private userSpeaking = false;
  private assistantAudioPlaying = false;
  // An empty-transcript VAD cut must not cancel the recovery response or Gali stays truncated mid-sentence.
  private noiseInterruptPending = false;
  private interruptRecoveryItemIds = new Set<string>();
  private interruptRecoveryReplays = 0;
  private lastSpeechStoppedAt = 0;
  private lastBackground: { responseId: string; topic: string | null } | null = null;
  private turnDetection: RealtimeTurnDetection | null = null;
  private readonly session = `voice-${Date.now()}`;
  private readonly phone: boolean;
  private readonly voiceMemory: "hosted" | "none";
  private readonly projectTitle: (projectKey: string) => string | undefined;
  private cb: Callbacks;
  private readonly announcements: AnnouncementQueue;
  private readonly tools: RealtimeToolDispatcher;

  constructor(
    cb: Callbacks,
    options: {
      voiceMemory: "hosted" | "none";
      phone?: boolean;
      projectTitle?: (projectKey: string) => string | undefined;
    },
  ) {
    this.cb = cb;
    this.phone = options.phone === true;
    this.voiceMemory = options.voiceMemory;
    this.projectTitle = options.projectTitle ?? (() => undefined);
    this.tools = new RealtimeToolDispatcher(this.session, canDownload);
    this.view = new AttachedView({
      send: (event) => this.raw(event),
      status: (event) => this.cb.onEvent(event),
      context: (text) => this.injectContext(text),
    });
    this.announcements = new AnnouncementQueue({
      send: (event) => this.raw(event),
      canFlush: () =>
        this.dc?.readyState === "open"
        && !this.toolResponsePending
        && !this.toolResponseRetry
        && this.activeResponses === 0
        && this.toolCallsInFlight === 0
        && !this.userSpeaking,
      quietForMs: () =>
        this.lastSpeechStoppedAt > 0
          ? Date.now() - this.lastSpeechStoppedAt
          : Number.POSITIVE_INFINITY,
      awaitsPlayback: () => this.voice,
    });
  }

  setLookHandler(handler: LookHandler | null) {
    this.lookHandler = handler;
  }

  setTileCaptureHandler(handler: TileCaptureHandler | null) {
    this.view.setCaptureHandler(handler);
  }

  isMuted() {
    return this.muted;
  }

  getMicStream(): MediaStream | null {
    return this.mic;
  }

  getRemoteAudioStream(): MediaStream | null {
    const src = this.audioEl?.srcObject;
    return src instanceof MediaStream ? src : null;
  }

  /** Call from a user gesture to retry playback after an autoplay block. */
  resumeAudio(): void {
    this.playAudio();
  }

  private setAudioBlocked(blocked: boolean) {
    if (this.audioBlocked === blocked) return;
    this.audioBlocked = blocked;
    this.cb.onAudioBlocked?.(blocked);
  }

  private playAudio() {
    const el = this.audioEl;
    if (!el) return;
    void el.play().then(
      () => this.setAudioBlocked(false),
      (err: unknown) => {
        if (isAutoplayBlocked(err)) this.setAudioBlocked(true);
      },
    );
  }

  async setMuted(muted: boolean): Promise<void> {
    const epoch = ++this.muteEpoch;
    this.muted = muted;
    if (muted) {
      this.unmuteIgnoreUntil = 0;
      await this.detachMic();
      if (epoch !== this.muteEpoch) return;
      if (this.dc?.readyState === "open") {
        this.raw({ type: "input_audio_buffer.clear" });
      }
      return;
    }
    await this.attachMic();
    if (epoch !== this.muteEpoch && this.muted) {
      await this.detachMic();
      return;
    }
    this.beginUnmuteHold();
  }

  private inUnmuteHold(): boolean {
    return this.unmuteIgnoreUntil > 0 && Date.now() < this.unmuteIgnoreUntil;
  }

  private beginUnmuteHold() {
    this.unmuteIgnoreUntil = Date.now() + UNMUTE_HOLD_MS;
    if (this.dc?.readyState === "open") {
      this.raw({ type: "input_audio_buffer.clear" });
    }
    window.setTimeout(() => {
      if (this.muted || Date.now() < this.unmuteIgnoreUntil) return;
      if (this.dc?.readyState === "open") {
        this.raw({ type: "input_audio_buffer.clear" });
      }
    }, UNMUTE_HOLD_MS);
  }

  private findAudioSender(): RTCRtpSender | undefined {
    if (!this.pc) return undefined;
    return (
      this.pc.getSenders().find((s) => s.track?.kind === "audio")
      ?? this.pc.getSenders().find((s) => s.track == null)
    );
  }

  private liveMicTrack(): MediaStreamTrack | undefined {
    return this.mic?.getAudioTracks().find((track) => track.readyState === "live");
  }

  private async detachMic(): Promise<void> {
    const sender = this.findAudioSender();
    if (sender) await sender.replaceTrack(null);
    for (const track of this.mic?.getAudioTracks() ?? []) {
      track.enabled = false;
    }
  }

  private async attachMic(): Promise<void> {
    if (!this.pc) throw new Error("Voice is not connected.");
    let track = this.liveMicTrack();
    if (!track) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
      });
      track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("No microphone track available.");
      }
      if (this.muted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.mic = stream;
    }
    if (this.muted) return;
    track.enabled = true;
    const sender = this.findAudioSender();
    if (sender) await sender.replaceTrack(track);
    else this.pc.addTrack(track, this.mic!);
  }

  private setReplies(modality: "audio" | "text") {
    this.raw({ type: "session.update", session: { type: "realtime", output_modalities: [modality] } });
  }

  async startVoice(): Promise<void> {
    if (this.voice) return;
    this.voice = true;
    this.setReplies("audio");
    try {
      await this.setMuted(false);
    } catch (err) {
      this.voice = false;
      this.setReplies("text");
      throw err;
    }
  }

  async connect(voice = true) {
    try {
      this.voice = voice;
      const tokenData = await mintRealtimeToken();
      const ephemeralKey = ephemeralKeyFromToken(tokenData);
      if (!ephemeralKey) throw new Error("no ephemeral key in token response");
      this.trialMetered = tokenData.metered === true;
      this.cb.onMetered?.(this.trialMetered);
      this.turnDetection = turnDetectionFromToken(tokenData.turn_detection);

      this.audioEl?.remove();
      this.audioEl = document.createElement("audio");
      this.audioEl.autoplay = true;
      this.audioEl.setAttribute("playsinline", "true");
      this.audioEl.style.display = "none";
      document.body.appendChild(this.audioEl);
      await connectRtcSession({
        ephemeralKey,
        model: tokenData.model,
        mic: voice,
        onMessage: (data) => {
          void this.onServerEvent(data as RealtimeServerEvent);
        },
        onTrack: (stream) => {
          if (!this.audioEl) return;
          this.audioEl.srcObject = stream;
          this.playAudio();
        },
        onCreated: ({ pc, dc, mic }) => {
          this.pc = pc;
          this.dc = dc;
          this.mic = mic;
          this.muted = false;
          this.muteEpoch += 1;
          dc.addEventListener("close", () => this.sessionDropped("channel closed"));
          pc.addEventListener("connectionstatechange", () => {
            if (pc.connectionState === "failed" || pc.connectionState === "closed") {
              this.sessionDropped(`connection ${pc.connectionState}`);
            }
          });
        },
        onConnected: () => {
          this.connectedAt = performance.now();
          this.cb.onConnected?.(true);
        },
      });
      if (!voice) this.setReplies("text");
      this.unsubscribeReviewer = onReviewerEvent((event) => this.onReviewerEvent(event));
      await this.injectResumeMemory();
    } catch (err) {
      await this.disconnect();
      throw err;
    }
  }

  private raw(event: unknown) {
    if (this.dc?.readyState !== "open") return;
    this.dc.send(JSON.stringify(event));
  }

  sendText(text: string, project?: { key: string; title: string }) {
    this.cb.onEvent({ kind: "message", role: "user", text });
    const busy = this.activeResponses > 0 || this.toolResponsePending || this.toolResponseRetry;
    if ((busy || this.assistantAudioPlaying) && !this.announcements.inFlight) {
      this.raw({ type: "response.cancel" });
      this.raw({ type: "output_audio_buffer.clear" });
    }
    if (project) {
      this.raw({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{
            type: "input_text",
            text: `The user typed the next message in project "${project.title}" (projectKey ${project.key}). It is about that project unless they name another one.`,
          }],
        },
      });
    }
    this.raw({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    if (busy) this.typedReplyPending = true;
    else this.raw({ type: "response.create" });
  }

  sendImage(
    image: { mime: "image/jpeg" | "image/png"; base64: string },
    text = LOOK_PROMPT,
  ) {
    this.view.attach(image, text, { kind: "status", text: "Shared a screen region with Gali" });
    this.requestToolResponse({ tools: false });
  }

  /**
   * Keep the model's attached image aligned with the viewer the user moved.
   * Replaces the previous visual; does not start a reply.
   */
  async syncOpenView(target: TileCaptureTarget): Promise<void> {
    if (this.dc?.readyState !== "open") return;
    const path = target.path?.trim();
    if (!path) return;
    const page = target.page !== undefined && Number.isInteger(target.page) && target.page > 0
      ? target.page
      : 1;
    await this.view.follow({ path, page });
  }

  clearOpenView(): void {
    this.view.clear();
  }

  async sendLook() {
    if (!this.dc || this.dc.readyState !== "open") {
      throw new Error("Voice channel is not connected.");
    }
    const result = await this.runLookCapture();
    if (result.status === "captured") {
      this.sendImage({ mime: result.mime, base64: result.base64 });
      return;
    }
    if (result.status === "cancelled") {
      this.cb.onEvent({ kind: "status", text: "Look cancelled" });
      return;
    }
    this.cb.onEvent({ kind: "status", text: `Look failed: ${result.error}` });
  }

  injectContext(text: string): boolean {
    if (this.dc?.readyState !== "open") return false;
    this.raw({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text }],
      },
    });
    return true;
  }

  private async injectResumeMemory() {
    if (this.voiceMemory !== "hosted") return;
    let memory: VoiceMemoryDto | null;
    try {
      memory = await fetchHostedVoiceMemory();
    } catch {
      return;
    }
    if (!memory || !memory.summary.trim()) return;
    const endedAt = Date.parse(memory.endedAt);
    if (!Number.isFinite(endedAt)) return;
    const ageMs = Date.now() - endedAt;
    if (ageMs < 0 || ageMs > MEMORY_MAX_AGE_MS) return;
    this.injectContext(
      `Memory from your previous conversation with this user (ended ${formatAgo(ageMs)}${
        memory.uiLocation ? `; they were ${memory.uiLocation}` : ""
      }). This is your record of last time — if they ask what you talked about, answer from it. Use it to pick up where you left off. Never mention this note or any memory system.\n\n${memory.summary}`,
    );
  }

  private onReviewerEvent(event: ReviewerEvent) {
    if (event.type === "reviewer.reviewing") return;
    const queue = this.reviewerQuestions.get(event.projectKey) ?? [];
    if (event.type === "reviewer.started") {
      queue.push(event.question);
      this.reviewerQuestions.set(event.projectKey, queue);
      this.cb.onEvent({
        kind: "status",
        text: `Working on ${event.projectKey}`,
        projectKey: event.projectKey,
        mark: { type: "reviewer", phase: "started" },
      });
      return;
    }
    const question = queue.shift();
    if (event.status === "cancelled") {
      this.cb.onEvent({
        kind: "status",
        text: `Stopped on ${event.projectKey}`,
        projectKey: event.projectKey,
        mark: { type: "reviewer", phase: "stopped" },
      });
      const asked = question ? ` The question was: "${question}".` : "";
      this.raw({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `Your earlier check on project "${this.projectTitle(event.projectKey) ?? event.projectKey}" was stopped and is not running.${asked} Do not reply to this note. Start it again only if the user asks.`,
          }],
        },
      });
      return;
    }
    if (event.status === "succeeded" && event.quiet) {
      this.cb.onEvent({
        kind: "status",
        text: `Working in the background on ${event.projectKey}${event.message ? `: ${event.message}` : ""}`,
        projectKey: event.projectKey,
        mark: { type: "reviewer", phase: "background" },
      });
      const asked = question ? ` The question was: "${question}".` : "";
      const said = event.message ? ` It said: "${event.message}"` : "";
      this.raw({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `Your earlier check on project "${this.projectTitle(event.projectKey) ?? event.projectKey}" now runs as a background job.${asked}${said} Do not reply to this note. The result comes later as its own update.`,
          }],
        },
      });
      return;
    }
    const failed = event.status === "failed";
    this.cb.onEvent({
      kind: "status",
      text: failed ? `Could not finish on ${event.projectKey}` : `Answer ready on ${event.projectKey}`,
      projectKey: event.projectKey,
      mark: { type: "reviewer", phase: failed ? "failed" : "finished" },
    });
    this.announcements.enqueue(reviewerSpeech(event, question, this.projectTitle(event.projectKey) ?? event.projectKey), {
      topic: event.projectKey,
      kind: failed ? "info" : "finished",
    });
  }

  private flushBackground() {
    this.announcements.flush();
  }

  private assistantLine(text: string, responseId: unknown): ChatEvent {
    const topic = this.lastBackground && this.lastBackground.responseId === responseId
      ? this.lastBackground.topic
      : null;
    return { kind: "message", role: "assistant", text, ...(topic ? { projectKey: topic } : {}) };
  }

  private async onServerEvent(event: RealtimeServerEvent) {
    switch (event.type) {
      case "conversation.item.input_audio_transcription.completed": {
        const itemId = typeof event.item_id === "string" ? event.item_id : "";
        if (
          this.trialMetered
          && itemId
          && event.usage
          && typeof event.usage === "object"
          && !Array.isArray(event.usage)
        ) {
          void reportTrialUsage({
            kind: "transcription",
            externalId: itemId,
            usage: event.usage as Record<string, unknown>,
          }).catch(() => {});
        }
        const recovering = itemId !== "" && this.interruptRecoveryItemIds.delete(itemId);
        const t = (event.transcript as string) ?? "";
        if (t.trim()) {
          this.interruptRecoveryReplays = 0;
          this.cb.onEvent({ kind: "message", role: "user", text: t });
          break;
        }
        if (itemId) this.raw({ type: "conversation.item.delete", item_id: itemId });
        const replayAllowed = !this.phone
          && recovering
          && this.interruptRecoveryReplays === 0;
        if (recovering) this.interruptRecoveryReplays += 1;
        if (
          !replayAllowed
          && this.turnDetection?.create_response
          && !this.announcements.inFlight
          && !this.toolResponsePending
        ) {
          this.raw({ type: "response.cancel" });
          this.raw({ type: "output_audio_buffer.clear" });
        }
        break;
      }
      case "input_audio_buffer.committed":
        if (this.toolResponseRetry && this.turnDetection?.create_response) {
          this.toolResponseRetry = false;
        }
        if (this.noiseInterruptPending) {
          this.noiseInterruptPending = false;
          const itemId = typeof event.item_id === "string" ? event.item_id : "";
          if (itemId) this.interruptRecoveryItemIds.add(itemId);
        }
        break;
      case "input_audio_buffer.speech_started": {
        if (this.inUnmuteHold()) {
          if (this.dc?.readyState === "open") {
            this.raw({ type: "input_audio_buffer.clear" });
            if (!this.announcements.inFlight && this.turnDetection?.create_response) {
              this.raw({ type: "response.cancel" });
              this.raw({ type: "output_audio_buffer.clear" });
              this.announcements.interruptPlaybackForFlush();
            }
          }
          break;
        }
        this.userSpeaking = true;
        // Only a cut into regular speech interrupts; background announcements requeue themselves.
        this.noiseInterruptPending = this.assistantAudioPlaying
          && !this.announcements.inFlight
          && !this.announcements.awaitingPlayback;
        this.announcements.interruptForSpeech();
        break;
      }
      case "input_audio_buffer.speech_stopped":
        this.userSpeaking = false;
        if (this.inUnmuteHold()) {
          if (this.dc?.readyState === "open") {
            this.raw({ type: "input_audio_buffer.clear" });
          }
          break;
        }
        this.lastSpeechStoppedAt = Date.now();
        this.flushBackground();
        break;
      case "response.created": {
        this.activeResponses += 1;
        const response = event.response as
          | { id?: string; metadata?: { purpose?: string } }
          | undefined;
        if (response?.metadata?.purpose === "gali_tool_answer") {
          this.toolResponsePending = false;
          break;
        }
        if (response?.metadata?.purpose === "gali_background") {
          this.announcements.onResponseCreated(response.id);
          if (response.id) {
            this.lastBackground = { responseId: response.id, topic: this.announcements.inFlight?.topic ?? null };
          }
        }
        break;
      }
      case "output_audio_buffer.started":
        this.assistantAudioPlaying = true;
        this.announcements.onAudioStarted(
          typeof event.response_id === "string" ? event.response_id : undefined,
        );
        break;
      case "output_audio_buffer.cleared":
        this.assistantAudioPlaying = false;
        this.announcements.onAudioCleared();
        break;
      case "output_audio_buffer.stopped":
        this.assistantAudioPlaying = false;
        this.interruptRecoveryReplays = 0;
        this.announcements.onAudioStopped(
          typeof event.response_id === "string" ? event.response_id : undefined,
        );
        break;
      case "response.output_audio_transcript.done": {
        const t = writeGaliName((event.transcript as string) ?? "");
        if (t.trim()) this.cb.onEvent(this.assistantLine(t, event.response_id));
        break;
      }
      case "response.output_text.done": {
        const t = writeGaliName((event.text as string) ?? "");
        if (t.trim()) this.cb.onEvent(this.assistantLine(t, event.response_id));
        break;
      }
      case "error": {
        const err = event.error as { message?: unknown; code?: unknown } | undefined;
        const message = String(err?.message ?? "");
        const code = String(err?.code ?? "");
        if (code === "session_expired" || /maximum duration/i.test(message)) {
          this.sessionDropped("session expired");
          break;
        }
        if (/cancel/i.test(message) || /cancel/i.test(code)) break;
        if (this.toolResponsePending && isActiveResponseError(event)) {
          this.toolResponsePending = false;
          this.toolResponseRetry = true;
          break;
        }
        if (isActiveResponseError(event)) this.announcements.onActiveResponseError();
        break;
      }
      case "response.done": {
        this.activeResponses = Math.max(0, this.activeResponses - 1);
        const response = event.response as
          | {
              id?: string;
              status?: string;
              metadata?: { purpose?: string };
              output?: FunctionCallItem[];
              usage?: Record<string, unknown>;
            }
          | undefined;
        if (this.trialMetered && response?.id && response.usage) {
          void reportTrialUsage({
            kind: "response",
            externalId: response.id,
            usage: response.usage,
          }).catch(() => {});
        }
        if (this.toolResponseRetry) {
          this.toolResponseRetry = false;
          this.requestToolResponse();
        }
        this.announcements.onResponseDone(response);
        // One spoken answer per batch: outputs land first, then a single tool answer.
        let answerWanted = false;
        const spoke = (response?.output ?? []).some((item) => item.type === "message");
        for (const item of response?.output ?? []) {
          if (item.type === "function_call" && !this.handledCalls.has(item.call_id)) {
            this.handledCalls.add(item.call_id);
            answerWanted = (await this.runTool(item, spoke)) || answerWanted;
          }
        }
        if (answerWanted) this.requestToolResponse();
        if (this.typedReplyPending && this.activeResponses === 0) {
          this.typedReplyPending = false;
          if (!this.toolResponsePending) this.raw({ type: "response.create" });
        }
        this.flushBackground();
        break;
      }
      default:
        break;
    }
  }

  private requestToolResponse(opts: { tools: boolean } = { tools: true }) {
    this.toolResponsePending = true;
    this.raw({
      type: "response.create",
      response: {
        metadata: { purpose: "gali_tool_answer" },
        ...(opts.tools ? {} : { tool_choice: "none" }),
      },
    });
  }

  private async runLookCapture(): Promise<LookCaptureResult> {
    if (!this.lookHandler) {
      return { status: "failed", error: "Look UI is not ready." };
    }
    return this.lookHandler();
  }

  private async runTool(item: FunctionCallItem, spoke: boolean): Promise<boolean> {
    this.toolCallsInFlight += 1;
    try {
      return await this.runToolInner(item, spoke);
    } finally {
      this.toolCallsInFlight = Math.max(0, this.toolCallsInFlight - 1);
    }
  }

  private output(callId: string, result: unknown) {
    this.raw({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
    });
  }

  /** Whether the tool wants a spoken answer after its output. */
  private async runToolInner(item: FunctionCallItem, spoke: boolean): Promise<boolean> {
    const args = anchorNoteToViewer(item.name, parseToolArguments(item.arguments), readOpenTileVisual(null));
    this.cb.onEvent({ kind: "tool_call", name: item.name });

    if (item.name === "wait_for_user") {
      this.output(item.call_id, { ok: true });
      return false;
    }

    if (item.name === "look_at_window") {
      const look = await this.runLookCapture();
      const result =
        look.status === "captured"
          ? { captured: true }
          : look.status === "cancelled"
            ? { cancelled: true }
            : { error: look.error };
      this.cb.onEvent({ kind: "tool", name: item.name, args, result });
      this.output(item.call_id, result);
      if (look.status === "captured") {
        this.sendImage({ mime: look.mime, base64: look.base64 });
        return false;
      }
      return true;
    }

    const pageBefore = item.name === "set_viewer_page" ? readOpenTilePage(null) : null;
    const result = await this.tools.dispatch(item.name, args);
    const tileView = await this.view.forTool(item.name, result, pageBefore, args.describe === true);
    this.cb.onEvent({ kind: "tool", name: item.name, args, result: tileView.result });
    this.output(item.call_id, tileView.result);
    tileView.afterOutput?.();
    if (item.name === "ask_reviewer" && spoke) {
      return typeof result !== "object" || result === null || "error" in result || "queued" in result;
    }
    return true;
  }

  // OpenAI ends every voice session after 60 minutes; without this the page
  // keeps showing a live call that no longer hears anything.
  private sessionDropped(reason: string) {
    if (this.tearingDown || !this.dc || this.connectedAt === 0) return;
    const lastedMs = performance.now() - this.connectedAt;
    void this.disconnect().then(() => this.cb.onDropped?.({ reason, lastedMs }));
  }

  async disconnect() {
    this.tearingDown = true;
    try {
      this.unsubscribeReviewer?.();
      this.dc?.close();
      this.pc?.getSenders().forEach((s) => s.track?.stop());
      this.mic?.getTracks().forEach((t) => t.stop());
      this.pc?.close();
    } finally {
      this.unsubscribeReviewer = null;
      this.reviewerQuestions.clear();
      this.toolResponsePending = false;
      this.toolResponseRetry = false;
      this.unmuteIgnoreUntil = 0;
      this.announcements.reset();
      this.activeResponses = 0;
      this.typedReplyPending = false;
      this.toolCallsInFlight = 0;
      this.assistantAudioPlaying = false;
      this.noiseInterruptPending = false;
      this.interruptRecoveryItemIds.clear();
      this.interruptRecoveryReplays = 0;
      this.userSpeaking = false;
      this.lastSpeechStoppedAt = 0;
      this.pc = null;
      this.dc = null;
      this.mic = null;
      this.muted = false;
      this.voice = true;
      this.muteEpoch += 1;
      this.view.reset();
      this.turnDetection = null;
      this.audioEl?.remove();
      this.audioEl = null;
      this.trialMetered = false;
      this.cb.onMetered?.(false);
      this.setAudioBlocked(false);
      this.cb.onConnected?.(false);
    }
  }
}
