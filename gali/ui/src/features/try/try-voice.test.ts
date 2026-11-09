import { beforeEach, expect, test, vi } from "vitest";

const rtc = vi.hoisted(() => ({
  onMessage: null as null | ((data: unknown) => void),
  sent: [] as Array<{ type: string }>,
}));

vi.mock("./try-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./try-api")>()),
  startTryVoiceCall: async () => ({ sdp: "answer-sdp", call: "rtc_1" }),
  extendTryVoiceCall: async () => {},
  endTryVoiceCall: () => {},
}));

vi.mock("../../realtime/rtc-session", () => ({
  connectRtcSession: async ({ onCreated, exchange, onMessage }: {
    onCreated: (session: unknown) => void;
    exchange: (offer: string) => Promise<string>;
    onMessage: (data: unknown) => void;
  }) => {
    rtc.onMessage = onMessage;
    const session = {
      pc: { connectionState: "connected", addEventListener: () => {}, close: () => {} },
      dc: { readyState: "open", send: (data: string) => rtc.sent.push(JSON.parse(data)), close: () => {} },
      mic: null,
    };
    onCreated(session);
    await exchange("offer-sdp");
    return session;
  },
}));

const { TryVoice } = await import("./try-voice");

beforeEach(() => {
  rtc.onMessage = null;
  rtc.sent = [];
});

async function connected(onAssistantText: (text: string) => void = () => {}) {
  const voice = new TryVoice({
    onUserText: () => {},
    onAssistantText,
    onSpeaking: () => {},
    onTool: () => {},
    onEnded: () => {},
    onLimit: () => {},
    answer: async () => "",
    turnPage: () => 1,
  });
  await voice.connect();
  return voice;
}

const types = () => rtc.sent.map((event) => event.type);

test("typing while Gali talks stops her, then answers the typed text once her reply ends", async () => {
  const voice = await connected();
  rtc.onMessage?.({ type: "response.created" });
  rtc.onMessage?.({ type: "output_audio_buffer.started" });

  voice.sendText("and figure 2?");

  expect(types()).toEqual(["response.cancel", "output_audio_buffer.clear", "conversation.item.create"]);
  rtc.onMessage?.({ type: "response.done", response: { status: "cancelled", output: [] } });
  await vi.waitFor(() => expect(types().filter((type) => type === "response.create")).toHaveLength(1));
  voice.close();
});

test("typing while Gali's last words still play cuts the audio and replies right away", async () => {
  const voice = await connected();
  rtc.onMessage?.({ type: "response.created" });
  rtc.onMessage?.({ type: "response.done", response: { output: [] } });
  rtc.onMessage?.({ type: "output_audio_buffer.started" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  rtc.sent = [];

  voice.sendText("wait, page 3");

  expect(types()).toEqual(["response.cancel", "output_audio_buffer.clear", "conversation.item.create", "response.create"]);
  voice.close();
});

test("the spoken name galì is written as Gali in the demo transcript", async () => {
  const said: string[] = [];
  const voice = await connected((text) => said.push(text));
  rtc.onMessage?.({ type: "response.output_audio_transcript.done", transcript: "Hi, I'm galì. " });
  expect(said).toEqual(["Hi, I'm Gali."]);
  voice.close();
});

test("typing while Gali is quiet asks for a reply right away and stops nothing", async () => {
  const voice = await connected();

  voice.sendText("what data do they use?");

  expect(types()).toEqual(["conversation.item.create", "response.create"]);
  voice.close();
});
