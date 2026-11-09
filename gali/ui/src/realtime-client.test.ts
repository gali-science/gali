import { beforeEach, expect, test, vi } from "vitest";
import type { ChatEvent } from "./realtime-client";

const rtc = vi.hoisted(() => ({
  input: null as null | { mic: boolean; onMessage: (data: unknown) => void },
  sent: [] as Array<{
    type: string;
    session?: { output_modalities?: string[] };
    response?: { metadata?: { purpose?: string } };
    item?: { type?: string; content?: Array<{ text?: string }> };
  }>,
  replaceTrack: vi.fn(async () => {}),
  reviewer: null as null | ((event: unknown) => void),
  toolResult: {} as unknown,
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  mintRealtimeToken: vi.fn(async () => ({ client_secret: "key", model: "model" })),
  onReviewerEvent: (cb: (event: unknown) => void) => {
    rtc.reviewer = cb;
    return () => {};
  },
  runVoiceTool: vi.fn(async () => rtc.toolResult),
}));
vi.mock("./realtime/rtc-session", () => ({
  connectRtcSession: async (input: {
    mic: boolean;
    onMessage: (data: unknown) => void;
    onCreated: (session: unknown) => void;
    onConnected: () => void;
  }) => {
    rtc.input = input;
    const dc = {
      readyState: "open",
      send: (data: string) => rtc.sent.push(JSON.parse(data)),
      addEventListener: () => {},
      close: () => {},
    };
    const sender = { track: null, replaceTrack: rtc.replaceTrack };
    const pc = {
      getSenders: () => [sender],
      addEventListener: () => {},
      close: () => {},
    };
    input.onCreated({ pc, dc, mic: input.mic ? { getTracks: () => [], getAudioTracks: () => [] } : null });
    input.onConnected();
    return { pc, dc, mic: null };
  },
}));

const { VoiceScientist } = await import("./realtime-client");

const micTrack = { kind: "audio", readyState: "live", enabled: false, stop: () => {} };
const getUserMedia = vi.fn(async () => ({
  getAudioTracks: () => [micTrack],
  getTracks: () => [micTrack],
}));

beforeEach(() => {
  rtc.input = null;
  rtc.sent = [];
  rtc.reviewer = null;
  rtc.toolResult = {};
  rtc.replaceTrack.mockClear();
  getUserMedia.mockClear();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
});

function modalities() {
  return rtc.sent
    .filter((event) => event.type === "session.update")
    .map((event) => event.session?.output_modalities);
}

function client() {
  return new VoiceScientist({ onEvent: () => {} }, { voiceMemory: "none" });
}

test("a text session connects without the mic and replies in text", async () => {
  const voice = client();
  await voice.connect(false);
  expect(rtc.input?.mic).toBe(false);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(modalities()).toEqual([["text"]]);
});

test("starting voice in a text session switches replies to audio and attaches the mic", async () => {
  const voice = client();
  await voice.connect(false);
  await voice.startVoice();
  expect(modalities()).toEqual([["text"], ["audio"]]);
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(rtc.replaceTrack).toHaveBeenCalledWith(micTrack);
  expect(voice.getMicStream()).not.toBeNull();
});

test("a voice session keeps audio replies", async () => {
  const voice = client();
  await voice.connect();
  expect(rtc.input?.mic).toBe(true);
  expect(modalities()).toEqual([]);
});

test("typing while Gali talks stops her, then answers the typed text once her reply ends", async () => {
  const voice = client();
  await voice.connect();
  rtc.input?.onMessage({ type: "response.created", response: { id: "r1" } });
  rtc.input?.onMessage({ type: "output_audio_buffer.started", response_id: "r1" });
  rtc.sent = [];

  voice.sendText("and figure 2?");

  expect(rtc.sent.map((event) => event.type)).toEqual(["response.cancel", "output_audio_buffer.clear", "conversation.item.create"]);
  rtc.input?.onMessage({ type: "response.done", response: { id: "r1", status: "cancelled", output: [] } });
  await vi.waitFor(() => expect(rtc.sent.filter((event) => event.type === "response.create")).toHaveLength(1));
  rtc.input?.onMessage({ type: "response.done", response: { id: "r2", status: "completed", output: [] } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(rtc.sent.filter((event) => event.type === "response.create")).toHaveLength(1);
});

test("typing while Gali is quiet asks for a reply right away and stops nothing", async () => {
  const voice = client();
  await voice.connect();
  rtc.sent = [];

  voice.sendText("what data do they use?");

  expect(rtc.sent.map((event) => event.type)).toEqual(["conversation.item.create", "response.create"]);
});

test("a message typed in a project tells Gali which project it is about, right before the message", async () => {
  const voice = client();
  await voice.connect();
  rtc.sent = [];

  voice.sendText("is the baseline fair?", { key: "p-1", title: "Neural Nets" });

  expect(rtc.sent.map((event) => event.type)).toEqual(["conversation.item.create", "conversation.item.create", "response.create"]);
  expect(rtc.sent[0]?.item?.content?.[0]?.text).toBe(
    'The user typed the next message in project "Neural Nets" (projectKey p-1). It is about that project unless they name another one.',
  );
  expect(rtc.sent[1]?.item?.content?.[0]?.text).toBe("is the baseline fair?");
});

test("Gali's spoken answer to a background update belongs to that update's project, and her other replies to none", async () => {
  const events: ChatEvent[] = [];
  await new VoiceScientist({ onEvent: (event) => events.push(event) }, { voiceMemory: "none" }).connect();
  rtc.reviewer?.({ type: "reviewer.started", projectKey: "p-2", question: "q", summary: "s" });
  rtc.reviewer?.({ type: "reviewer.finished", projectKey: "p-2", status: "succeeded", message: "Table 2 is right." });
  await vi.waitFor(() => expect(rtc.sent.some((event) => event.response?.metadata?.purpose === "gali_background")).toBe(true));

  rtc.input?.onMessage({ type: "response.created", response: { id: "bg-1", metadata: { purpose: "gali_background" } } });
  rtc.input?.onMessage({ type: "response.output_audio_transcript.done", response_id: "bg-1", transcript: "Table 2 checks out." });
  rtc.input?.onMessage({ type: "response.created", response: { id: "r-9" } });
  rtc.input?.onMessage({ type: "response.output_audio_transcript.done", response_id: "r-9", transcript: "Sure." });

  expect(events.filter((event) => event.kind === "message")).toEqual([
    { kind: "message", role: "assistant", text: "Table 2 checks out.", projectKey: "p-2" },
    { kind: "message", role: "assistant", text: "Sure." },
  ]);
});

async function askReviewer({ spoke, result }: { spoke: boolean; result: unknown }): Promise<number> {
  rtc.toolResult = result;
  await client().connect();
  rtc.input?.onMessage({
    type: "response.done",
    response: {
      id: "r1",
      status: "completed",
      output: [
        ...(spoke ? [{ type: "message" }] : []),
        { type: "function_call", name: "ask_reviewer", call_id: "c1", arguments: JSON.stringify({ projectKey: "p", question: "q", summary: "s" }) },
      ],
    },
  });
  await vi.waitFor(() => expect(rtc.sent.some((event) => event.item?.type === "function_call_output")).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return rtc.sent.filter((event) => event.type === "response.create" && event.response?.metadata?.purpose === "gali_tool_answer").length;
}

test("after saying she is asking the reviewer, Gali does not speak again", async () => {
  expect(await askReviewer({ spoke: true, result: { asked: true, projectKey: "p" } })).toBe(0);
});

test("Gali still answers after asking the reviewer when it is queued, failed, or she said nothing yet", async () => {
  expect(await askReviewer({ spoke: true, result: { asked: true, projectKey: "p", queued: "runs next" } })).toBe(1);
  rtc.sent = [];
  expect(await askReviewer({ spoke: true, result: { error: "no such paper" } })).toBe(1);
  rtc.sent = [];
  expect(await askReviewer({ spoke: false, result: { asked: true, projectKey: "p" } })).toBe(1);
});

test("a background review starting or ending is not spoken", async () => {
  await client().connect();
  rtc.reviewer?.({ type: "reviewer.reviewing", projectKey: "p", running: true });
  rtc.reviewer?.({ type: "reviewer.reviewing", projectKey: "p", running: false });
  expect(rtc.sent.filter((event) => event.type === "conversation.item.create" || event.type === "response.create")).toEqual([]);
});

test("a reviewer update is spoken no longer than the reviewer's own answer", async () => {
  await client().connect();
  rtc.reviewer?.({ type: "reviewer.started", projectKey: "p", question: "q", summary: "s" });
  rtc.reviewer?.({ type: "reviewer.finished", projectKey: "p", status: "succeeded", message: "The review has started." });
  const update = rtc.sent.find((event) => event.type === "conversation.item.create" && event.item?.type === "message");
  const text = update?.item?.content?.[0]?.text ?? "";
  expect(text).toContain("The review has started.");
  expect(text).toContain("never longer than the answer");
  expect(text).toContain("If it only says the work started or is still running, say so in one short sentence.");
  expect(text).toContain("Mention a review file only if the answer names one.");
  expect(text).not.toContain("two to four");
});

test("a reviewer answer or failure names the project by its title, not its key", async () => {
  const titles = new Map([["2602-16687v1", "Audio Foundation Models"]]);
  const spoken = async (finished: Record<string, unknown>) => {
    rtc.sent = [];
    await new VoiceScientist(
      { onEvent: () => {} },
      { voiceMemory: "none", projectTitle: (key) => titles.get(key) },
    ).connect();
    rtc.reviewer?.({ type: "reviewer.started", projectKey: "2602-16687v1", question: "q", summary: "s" });
    rtc.reviewer?.({ type: "reviewer.finished", projectKey: "2602-16687v1", ...finished });
    const update = rtc.sent.find((event) => event.type === "conversation.item.create" && event.item?.type === "message");
    return update?.item?.content?.[0]?.text ?? "";
  };
  const answered = await spoken({ status: "succeeded", message: "Job 1 is done." });
  const failed = await spoken({ status: "failed", error: "boom" });
  expect(answered).toContain('Your earlier check finished on project "Audio Foundation Models".');
  expect(answered).toContain("If that project is not the one the user has open, name it in a few words first.");
  expect(failed).toContain('Your earlier check could not finish on project "Audio Foundation Models".');
  expect(failed).toContain("naming the project in a few words if it is not the one they have open");
  expect(`${answered}${failed}`).not.toContain("2602-16687v1");
  expect(`${answered}${failed}`).not.toMatch(/reviewer/i);
});

test("a reply that only hands work to a background job shows in the chat, and Gali knows it without speaking", async () => {
  const events: ChatEvent[] = [];
  await new VoiceScientist(
    { onEvent: (event) => events.push(event) },
    { voiceMemory: "none", projectTitle: (key) => (key === "p" ? "Neural Nets" : undefined) },
  ).connect();
  rtc.sent = [];
  rtc.reviewer?.({ type: "reviewer.started", projectKey: "p", question: "Make a plot", summary: "s" });
  rtc.reviewer?.({ type: "reviewer.finished", projectKey: "p", status: "succeeded", message: "The job has started.", quiet: true });
  expect(events.filter((event) => event.kind === "status").at(-1)).toEqual({
    kind: "status",
    text: "Working in the background on p: The job has started.",
    projectKey: "p",
    mark: { type: "reviewer", phase: "background" },
  });
  const notes = rtc.sent.filter((event) => event.type === "conversation.item.create" && event.item?.type === "message");
  expect(notes.map((event) => event.item?.content?.[0]?.text)).toEqual([
    'Your earlier check on project "Neural Nets" now runs as a background job. The question was: "Make a plot". It said: "The job has started." Do not reply to this note. The result comes later as its own update.',
  ]);
  expect(rtc.sent.some((event) => event.type === "response.create")).toBe(false);
  rtc.sent = [];

  rtc.reviewer?.({ type: "reviewer.started", projectKey: "p", question: "Add mock data", summary: "s" });
  rtc.reviewer?.({ type: "reviewer.finished", projectKey: "p", status: "succeeded", message: "", quiet: true });
  expect(events.filter((event) => event.kind === "status").at(-1)?.text).toBe("Working in the background on p");
  expect(rtc.sent.map((event) => event.item?.content?.[0]?.text)).toEqual([
    'Your earlier check on project "Neural Nets" now runs as a background job. The question was: "Add mock data". Do not reply to this note. The result comes later as its own update.',
  ]);
  rtc.sent = [];

  rtc.reviewer?.({ type: "reviewer.started", projectKey: "p", question: "Report it", summary: "s" });
  rtc.reviewer?.({ type: "reviewer.finished", projectKey: "p", status: "succeeded", message: "The plot is in the Findings tab." });
  const update = rtc.sent.find((event) => event.type === "conversation.item.create" && event.item?.type === "message");
  expect(update?.item?.content?.[0]?.text).toContain("The plot is in the Findings tab.");
});

test("a stopped reviewer turn shows as stopped, not failed, and Gali knows without speaking", async () => {
  const events: ChatEvent[] = [];
  await new VoiceScientist(
    { onEvent: (event) => events.push(event) },
    { voiceMemory: "none", projectTitle: (key) => (key === "p" ? "False Friends" : undefined) },
  ).connect();
  rtc.sent = [];
  rtc.reviewer?.({ type: "reviewer.started", projectKey: "p", question: "Check all the math", summary: "s" });
  rtc.reviewer?.({ type: "reviewer.finished", projectKey: "p", status: "cancelled" });
  expect(events.filter((event) => event.kind === "status").at(-1)).toEqual({
    kind: "status",
    text: "Stopped on p",
    projectKey: "p",
    mark: { type: "reviewer", phase: "stopped" },
  });
  const notes = rtc.sent.filter((event) => event.type === "conversation.item.create" && event.item?.type === "message");
  expect(notes.map((event) => event.item?.content?.[0]?.text)).toEqual([
    'Your earlier check on project "False Friends" was stopped and is not running. The question was: "Check all the math". Do not reply to this note. Start it again only if the user asks.',
  ]);
  expect(rtc.sent.some((event) => event.type === "response.create")).toBe(false);
});
