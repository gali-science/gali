import { useEffect, useState } from "react";

export function useStreamLevel(stream: () => MediaStream | null, active: boolean, floor: number, gain: number): number {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!active) {
      setLevel(0);
      return;
    }
    let alive = true;
    let raf = 0;
    let poll = 0;
    let lastPublish = 0;
    let audioContext: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    const samples = new Uint8Array(512);

    const attach = (media: MediaStream) => {
      audioContext = new AudioContext();
      source = audioContext.createMediaStreamSource(media);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      const tick = () => {
        if (!alive) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) {
          const v = (sample - 128) / 128;
          sum += v * v;
        }
        const now = performance.now();
        if (now - lastPublish >= 40) {
          lastPublish = now;
          setLevel(Math.min(1, Math.max(0, (Math.sqrt(sum / samples.length) - floor) * gain)));
        }
        raf = requestAnimationFrame(tick);
      };
      void audioContext.resume().then(() => {
        if (alive) raf = requestAnimationFrame(tick);
      });
    };

    const tryAttach = () => {
      if (!alive) return;
      const media = stream();
      if (media) attach(media);
      else poll = window.setTimeout(tryAttach, 200);
    };
    tryAttach();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.clearTimeout(poll);
      source?.disconnect();
      void audioContext?.close();
      setLevel(0);
    };
  }, [stream, active, floor, gain]);

  return level;
}
