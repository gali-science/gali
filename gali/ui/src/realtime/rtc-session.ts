type RtcSessionInput = {
  mic: boolean;
  onMessage: (data: unknown) => void;
  onTrack: (stream: MediaStream) => void;
  onCreated: (session: RtcSession) => void;
  onConnected: () => void;
} & ({ ephemeralKey: string; model: string } | { exchange: (offer: string) => Promise<string> });

export type RtcSession = {
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  mic: MediaStream | null;
};

export async function connectRtcSession(input: RtcSessionInput): Promise<RtcSession> {
  const pc = new RTCPeerConnection();
  pc.ontrack = (event) => input.onTrack(event.streams[0]!);

  const mic = input.mic
    ? await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    })
    : null;
  if (mic) for (const track of mic.getTracks()) pc.addTrack(track, mic);
  else pc.addTransceiver("audio", { direction: "sendrecv" });

  const dc = pc.createDataChannel("oai-events");
  input.onCreated({ pc, dc, mic });
  dc.addEventListener("message", (event) => {
    input.onMessage(JSON.parse(String((event as MessageEvent<unknown>).data)));
  });
  const channelReady = new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("voice data channel timeout")),
      20_000,
    );
    dc.addEventListener("open", () => {
      window.clearTimeout(timer);
      input.onConnected();
      resolve();
    });
    dc.addEventListener("error", () => {
      window.clearTimeout(timer);
      reject(new Error("voice data channel failed"));
    });
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await pc.setRemoteDescription({ type: "answer", sdp: await answerFor(input, offer.sdp ?? "") });
  await channelReady;
  return { pc, dc, mic };
}

async function answerFor(input: RtcSessionInput, offer: string): Promise<string> {
  if ("exchange" in input) return input.exchange(offer);
  const response = await fetch(
    `https://api.openai.com/v1/realtime/calls?model=${input.model}`,
    {
      method: "POST",
      body: offer,
      headers: {
        Authorization: `Bearer ${input.ephemeralKey}`,
        "Content-Type": "application/sdp",
      },
    },
  );
  if (!response.ok) throw new Error(`sdp exchange failed: ${await response.text()}`);
  return response.text();
}
