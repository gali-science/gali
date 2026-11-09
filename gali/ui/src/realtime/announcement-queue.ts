import type {
  BackgroundEntry,
  BackgroundKind,
} from "./session-announcements";

const BACKGROUND_QUEUE_MAX = 3;
const BACKGROUND_QUIET_MS = 2_000;

type AnnouncementQueueOptions = {
  send: (event: unknown) => void;
  canFlush: () => boolean;
  quietForMs: () => number;
  awaitsPlayback: () => boolean;
};

type BackgroundResponse = {
  id?: string;
  status?: string;
  metadata?: { purpose?: string };
  output?: Array<{ type?: string }>;
};

export class AnnouncementQueue {
  private queue: BackgroundEntry[] = [];
  private current: BackgroundEntry | null = null;
  private responseId: string | null = null;
  private playback: { entry: BackgroundEntry; responseId: string } | null = null;
  private itemSeq = 0;
  private quietTimer: number | null = null;

  constructor(private readonly options: AnnouncementQueueOptions) {}

  get inFlight(): BackgroundEntry | null {
    return this.current;
  }

  get inFlightResponseId(): string | null {
    return this.responseId;
  }

  get awaitingPlayback(): { entry: BackgroundEntry; responseId: string } | null {
    return this.playback;
  }

  set awaitingPlayback(value: { entry: BackgroundEntry; responseId: string } | null) {
    this.playback = value;
  }

  get busy(): boolean {
    return this.current !== null || this.playback !== null;
  }

  clear(): void {
    this.queue = [];
    this.playback = null;
    if (this.quietTimer !== null) {
      window.clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
  }

  reset(): void {
    this.clear();
    this.current = null;
    this.responseId = null;
    this.itemSeq = 0;
  }

  enqueue(
    text: string,
    tag?: { topic: string; kind: BackgroundKind },
  ): void {
    this.itemSeq += 1;
    this.queue.push({
      text: `(background update, please tell me about this) ${text}`,
      itemSent: false,
      itemId: `bg_${this.itemSeq}_${Date.now()}`,
      topic: tag?.topic ?? null,
      kind: tag?.kind ?? "info",
    });
    if (this.queue.length > BACKGROUND_QUEUE_MAX) this.queue.shift();
    this.flush();
  }

  purge(topic: string, kinds?: readonly BackgroundKind[]): void {
    const matches = (entry: BackgroundEntry) =>
      entry.topic === topic
      && (kinds === undefined || kinds.includes(entry.kind));
    const kept: BackgroundEntry[] = [];
    for (const entry of this.queue) {
      if (!matches(entry)) {
        kept.push(entry);
      } else if (entry.itemSent) {
        this.deleteItem(entry);
      }
    }
    this.queue = kept;
    if (this.current && matches(this.current)) {
      this.cancelOutput();
      this.deleteItem(this.current);
      this.current = null;
      this.responseId = null;
    }
    if (this.playback && matches(this.playback.entry)) {
      this.options.send({ type: "output_audio_buffer.clear" });
      this.deleteItem(this.playback.entry);
      this.playback = null;
    }
  }

  flush(): void {
    if (this.busy || this.queue.length === 0 || !this.options.canFlush()) return;
    const quietFor = this.options.quietForMs();
    if (quietFor < BACKGROUND_QUIET_MS) {
      this.scheduleFlush(BACKGROUND_QUIET_MS - quietFor);
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.responseId = null;
    if (!next.itemSent) {
      this.options.send({
        type: "conversation.item.create",
        item: {
          id: next.itemId,
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: next.text }],
        },
      });
      next.itemSent = true;
    }
    this.options.send({
      type: "response.create",
      response: { metadata: { purpose: "gali_background" } },
    });
  }

  onResponseCreated(responseId: string | undefined): void {
    if (this.current && responseId) this.responseId = responseId;
  }

  onAudioStarted(responseId?: string): void {
    if (!this.current || this.responseId === null) return;
    if (responseId && responseId !== this.responseId) return;
    this.current.heard = true;
  }

  onResponseDone(response: BackgroundResponse | undefined): boolean {
    if (
      this.current
      && (response?.metadata?.purpose === "gali_background"
        || (this.responseId !== null && response?.id === this.responseId))
    ) {
      const completedResponseId = response?.id ?? this.responseId;
      const spoke = (response?.output ?? []).some((item) => item.type === "message");
      if (response?.status === "completed" && spoke && completedResponseId && this.options.awaitsPlayback()) {
        this.playback = { entry: this.current, responseId: completedResponseId };
      }
      this.current = null;
      this.responseId = null;
      return true;
    }
    if (this.current && this.responseId === null) {
      this.requeue(this.current);
      this.current = null;
      return true;
    }
    return false;
  }

  onActiveResponseError(): boolean {
    if (!this.current || this.responseId !== null) return false;
    this.requeue(this.current);
    this.current = null;
    return true;
  }

  onAudioStopped(responseId?: string): boolean {
    if (!this.playback || (responseId && responseId !== this.playback.responseId)) return false;
    this.playback = null;
    this.flush();
    return true;
  }

  onAudioCleared(): void {
    this.playback = null;
  }

  interruptForSpeech(): void {
    if (this.current) {
      this.cancelOutput();
      if (!this.current.heard) this.requeue(this.current);
      this.current = null;
      this.responseId = null;
    }
    if (this.playback) {
      this.options.send({ type: "output_audio_buffer.clear" });
      this.playback = null;
    }
  }

  interruptPlaybackForFlush(): void {
    if (!this.playback) return;
    this.requeue(this.playback.entry);
    this.playback = null;
  }

  private requeue(entry: BackgroundEntry): void {
    if (entry.itemSent) {
      this.deleteItem(entry);
      entry.itemSent = false;
    }
    this.queue.unshift(entry);
  }

  private deleteItem(entry: BackgroundEntry): void {
    if (!entry.itemSent) return;
    this.options.send({ type: "conversation.item.delete", item_id: entry.itemId });
  }

  private cancelOutput(): void {
    this.options.send({ type: "response.cancel" });
    this.options.send({ type: "output_audio_buffer.clear" });
  }

  private scheduleFlush(delayMs: number): void {
    if (this.quietTimer !== null) return;
    this.quietTimer = window.setTimeout(() => {
      this.quietTimer = null;
      this.flush();
    }, delayMs);
  }
}
