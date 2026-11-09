import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { connectRtcSession } from "./rtc-session";

const calls = vi.hoisted(() => ({
  addTrack: [] as unknown[][],
  addTransceiver: [] as unknown[][],
}));

class FakeChannel extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
}

class FakePeer {
  ontrack: unknown = null;
  addTrack(...args: unknown[]) {
    calls.addTrack.push(args);
  }
  addTransceiver(...args: unknown[]) {
    calls.addTransceiver.push(args);
  }
  createDataChannel() {
    return new FakeChannel();
  }
  async createOffer() {
    return { type: "offer", sdp: "offer-sdp" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
}

const getUserMedia = vi.fn();

beforeEach(() => {
  calls.addTrack = [];
  calls.addTransceiver = [];
  getUserMedia.mockReset();
  const track = { kind: "audio" };
  getUserMedia.mockResolvedValue({ getTracks: () => [track] });
  vi.stubGlobal("RTCPeerConnection", FakePeer);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "answer-sdp" })));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function connect(mic: boolean) {
  return connectRtcSession({
    ephemeralKey: "key",
    model: "model",
    mic,
    onMessage: () => {},
    onTrack: () => {},
    onCreated: () => {},
    onConnected: () => {},
  });
}

test("a session without the mic never asks for it and still negotiates two-way audio", async () => {
  const session = await connect(false);
  expect(getUserMedia).not.toHaveBeenCalled();
  expect(calls.addTrack).toHaveLength(0);
  expect(calls.addTransceiver).toEqual([["audio", { direction: "sendrecv" }]]);
  expect(session.mic).toBeNull();
});

test("a session with its own exchange sends the offer there and never calls OpenAI from the browser", async () => {
  const exchange = vi.fn(async () => "answer-sdp");
  const setRemoteDescription = vi.spyOn(FakePeer.prototype, "setRemoteDescription");

  await connectRtcSession({
    exchange,
    mic: false,
    onMessage: () => {},
    onTrack: () => {},
    onCreated: () => {},
    onConnected: () => {},
  });

  expect(exchange).toHaveBeenCalledWith("offer-sdp");
  expect(setRemoteDescription).toHaveBeenCalledWith({ type: "answer", sdp: "answer-sdp" });
  expect(fetch).not.toHaveBeenCalled();
});

test("a voice session sends the mic track", async () => {
  const session = await connect(true);
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(calls.addTrack).toHaveLength(1);
  expect(calls.addTransceiver).toHaveLength(0);
  expect(session.mic).not.toBeNull();
});
