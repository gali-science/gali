import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { captureErrorMessage } from "./features/voice/capture-page";
import { usePlatform } from "./platform/context";
import {
  VoiceScientist,
  type ChatEvent,
  type LookCaptureResult,
  type StatusMark,
  type TileCaptureHandler,
  type TileCaptureTarget,
} from "./realtime-client";
import { buildTranscript, pushHostedVoiceMemory } from "./voice-memory";

export type VoiceLine =
  | { id: number; kind: "message"; role: string; text: string; projectKey?: string }
  | { id: number; kind: "tool"; name: string; args: unknown; result: unknown; projectKey?: string }
  | { id: number; kind: "status"; text: string; projectKey?: string; mark?: StatusMark };

// A failed fetch reads as "NetworkError when attempting to fetch a resource"
// (Firefox), "Load failed" (Safari) or "Failed to fetch" (Chrome) — useless to a
// user whose sandbox is simply still waking up.
// A drop this soon after connecting is a broken link, not the 60-minute
// session cap; reconnecting would loop.
const RECONNECT_MIN_SESSION_MS = 60_000;

function lineProject(e: Exclude<ChatEvent, { kind: "tool_call" }>, open: string | null): string | undefined {
  if (e.kind !== "tool" && e.projectKey) return e.projectKey;
  if (e.kind === "tool") {
    const args = e.args && typeof e.args === "object" ? (e.args as { projectKey?: unknown }) : {};
    const result = e.result && typeof e.result === "object"
      ? (e.result as { projectKey?: unknown; project?: { key?: unknown } | null })
      : {};
    for (const key of [args.projectKey, result.projectKey, result.project?.key]) {
      if (typeof key === "string" && key) return key;
    }
  }
  return open ?? undefined;
}

function isFetchFailure(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  return /networkerror|failed to fetch|load failed|network request failed/i.test(err.message);
}

function startErrorMessage(err: unknown): string {
  const raw = captureErrorMessage(err);
  return isFetchFailure(err)
    ? "Couldn't reach your workspace — it may still be waking up. Try again."
    : /permission|notallowed|denied/i.test(raw)
      ? "Microphone blocked — allow access in the browser (or System Settings → Privacy & Security → Microphone), then try again."
      : raw;
}

// "Gali is ready" cue, synthesized in place. Runs off the Talk-button
// gesture, so mobile audio playback is already unlocked.
function playConnectedChime(): void {
  try {
    const ctx = new AudioContext();
    const note = (
      dest: AudioNode,
      frequency: number,
      at: number,
      dur: number,
      peak: number,
      attack: number,
      type: OscillatorType,
    ) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + at;
      osc.type = type;
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    };
    // Chord bed: a slow-attack triangle through a lowpass, straight to out.
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 1600;
    lowpass.connect(ctx.destination);
    note(lowpass, 440, 0, 0.8, 0.06, 0.15, "triangle");
    // Arpeggio: heard only through a feedback delay — the repeats shimmer.
    const send = ctx.createGain();
    const delay = ctx.createDelay(1);
    const feedback = ctx.createGain();
    const wet = ctx.createGain();
    delay.delayTime.value = 0.095;
    feedback.gain.value = 0.35;
    wet.gain.value = 0.4;
    send.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(ctx.destination);
    [880, 1046.5, 1318.5].forEach((frequency, i) => {
      note(send, frequency, 0.05 + i * 0.07, 0.35, 0.05, 0.015, "sine");
    });
    window.setTimeout(() => void ctx.close(), 1500);
  } catch {
    // Best-effort: never let the cue break connecting.
  }
}

export function useVoice(
  onChanged: () => void,
  trial?: {
    canStart: () => boolean;
    onStartBlocked: () => void;
  },
  phone = false,
  projects: ReadonlyArray<{ key: string; title: string }> = [],
  openProjectKey: string | null = null,
) {
  const platform = usePlatform();
  const canStart = trial?.canStart;
  const onStartBlocked = trial?.onStartBlocked;
  const [lines, setLines] = useState<VoiceLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [muted, setMuted] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [toolPulse, setToolPulse] = useState(0);
  const [pendingTool, setPendingTool] = useState<string | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [metered, setMetered] = useState(false);
  const clientRef = useRef<VoiceScientist | null>(null);
  const lookHandlerRef = useRef<(() => Promise<LookCaptureResult>) | null>(null);
  const tileHandlerRef = useRef<TileCaptureHandler | null>(null);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const startRef = useRef<(() => Promise<void>) | null>(null);
  const stopPromiseRef = useRef<Promise<void> | null>(null);
  const voiceOnRef = useRef(false);
  const linesRef = useRef<VoiceLine[]>([]);
  linesRef.current = lines;
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const openProjectRef = useRef(openProjectKey);
  openProjectRef.current = openProjectKey;
  const live = connected && voiceOn;

  const markVoiceOn = useCallback((on: boolean) => {
    voiceOnRef.current = on;
    setVoiceOn(on);
  }, []);

  // Hosted memory: the transcript tail streams to the control plane as the
  // conversation happens, so memory survives tab closes and sandbox
  // re-provisioning. Plain debounced writes — no model call, no voice lag.
  useEffect(() => {
    if (platform.capabilities.voiceMemory !== "hosted") return;
    if (!connected || lines.length === 0) return;
    const timer = window.setTimeout(() => {
      const transcript = buildTranscript(lines);
      if (transcript) void pushHostedVoiceMemory({ transcript }).catch(() => {});
    }, 3_000);
    return () => window.clearTimeout(timer);
  }, [lines, connected, platform.capabilities.voiceMemory]);

  const push = useCallback(
    (e: ChatEvent) => {
      if (e.kind === "tool_call") {
        setToolPulse((n) => n + 1);
        // wait_for_user never reports completion, so it must not hold the chip.
        if (e.name !== "wait_for_user") setPendingTool(e.name);
        return;
      }
      if (e.kind === "tool") setPendingTool(null);
      const projectKey = lineProject(e, openProjectRef.current);
      // Ids derive from state, not a module counter, which hot reloads reset.
      setLines((prev) => [
        ...prev,
        { id: (prev[prev.length - 1]?.id ?? -1) + 1, ...e, ...(projectKey ? { projectKey } : {}) } as VoiceLine,
      ]);
      if (e.kind === "tool" || e.kind === "status") onChanged();
    },
    [onChanged],
  );

  useEffect(() => {
    if (!connected) setPendingTool(null);
  }, [connected]);

  const bindLookHandler = useCallback((client: VoiceScientist) => {
    client.setLookHandler(async () => {
      if (!lookHandlerRef.current) {
        return { status: "failed", error: "Look UI is not ready." };
      }
      return lookHandlerRef.current();
    });
  }, []);

  const setLookCapture = useCallback((handler: (() => Promise<LookCaptureResult>) | null) => {
    lookHandlerRef.current = handler;
    if (clientRef.current) bindLookHandler(clientRef.current);
  }, [bindLookHandler]);

  const bindTileHandler = useCallback((client: VoiceScientist) => {
    client.setTileCaptureHandler(async (target) => {
      if (!tileHandlerRef.current) {
        return { status: "failed", error: "the viewer is not ready" };
      }
      return tileHandlerRef.current(target);
    });
  }, []);

  const setTileCapture = useCallback((handler: TileCaptureHandler | null) => {
    tileHandlerRef.current = handler;
    if (clientRef.current) bindTileHandler(clientRef.current);
  }, [bindTileHandler]);

  const enableVoice = useCallback(async (client: VoiceScientist) => {
    setError(null);
    setConnecting(true);
    try {
      await client.startVoice();
    } catch (err) {
      setError(startErrorMessage(err));
      throw err;
    } finally {
      setConnecting(false);
    }
    playConnectedChime();
    markVoiceOn(true);
  }, [markVoiceOn]);

  const open = useCallback(async (voice: boolean) => {
    if (canStart && !canStart()) {
      onStartBlocked!();
      throw new Error("Your trial is spent.");
    }
    if (startPromiseRef.current) {
      await startPromiseRef.current;
      if (voice && clientRef.current && !voiceOnRef.current) await enableVoice(clientRef.current);
      return;
    }
    if (clientRef.current && !stopPromiseRef.current) {
      if (voice && !voiceOnRef.current) await enableVoice(clientRef.current);
      return;
    }
    setError(null);
    // Show Connecting before awaiting the previous teardown below, or the
    // button sits idle for those seconds on a quick End -> Talk.
    setConnecting(true);
    if (stopPromiseRef.current) await stopPromiseRef.current;
    if (clientRef.current) {
      setConnecting(false);
      return;
    }
    const pending = (async () => {
      try {
        if (!platform.client) throw new Error("Voice needs a connected Gali runtime.");
        const client = new VoiceScientist({
          onEvent: push,
          onConnected: (c) => {
            setConnected(c);
            // The old client's teardown fires onConnected(false) mid-reconnect;
            // it must not clear Connecting. Failures clear it in the catch below.
            if (c) setConnecting(false);
          },
          onAudioBlocked: setAudioBlocked,
          onMetered: setMetered,
          onDropped: ({ lastedMs }) => {
            if (clientRef.current !== client) return;
            clientRef.current = null;
            const wasVoice = voiceOnRef.current;
            setConnected(false);
            markVoiceOn(false);
            setMuted(false);
            if (lastedMs < RECONNECT_MIN_SESSION_MS) {
              setError("The voice connection dropped. Tap Talk to reconnect.");
              return;
            }
            if (!wasVoice) return;
            push({ kind: "status", text: "Voice session ended, reconnecting" });
            void startRef.current!().catch(() => {});
          },
        }, {
          phone,
          voiceMemory: platform.capabilities.voiceMemory,
          projectTitle: (key) => projectsRef.current.find((project) => project.key === key)?.title,
        });
        bindLookHandler(client);
        bindTileHandler(client);
        clientRef.current = client;
        markVoiceOn(voice);
        await client.connect(voice);
        if (voice) playConnectedChime();
        setConnected(true);
        setConnecting(false);
      } catch (err) {
        setError(startErrorMessage(err));
        markVoiceOn(false);
        setConnecting(false);
        const failed = clientRef.current;
        clientRef.current = null;
        await failed?.disconnect();
        throw err;
      } finally {
        startPromiseRef.current = null;
      }
    })();
    startPromiseRef.current = pending;
    await pending;
  }, [
    bindLookHandler,
    bindTileHandler,
    canStart,
    enableVoice,
    markVoiceOn,
    onStartBlocked,
    phone,
    platform.capabilities.voiceMemory,
    platform.client,
    push,
  ]);

  const start = useCallback(() => open(true), [open]);
  const openSession = useCallback(() => open(false), [open]);

  startRef.current = start;

  const stop = useCallback(async () => {
    if (stopPromiseRef.current) {
      await stopPromiseRef.current;
      return;
    }
    const client = clientRef.current;
    // The UI shows "ended" immediately (stopping masks connected); the goodbye
    // memory note and the actual teardown finish in the background.
    setStopping(true);
    // Ending the session dismisses whatever went wrong during it, or the banner
    // outlives the call it describes.
    setError(null);
    const pending = (async () => {
      try {
        if (client) {
          try {
            await client.setMuted(true);
            if (platform.capabilities.voiceMemory === "hosted") {
              // Flush the transcript tail (the debounce may not have fired for
              // the last lines); the control plane summarizes later.
              const transcript = buildTranscript(linesRef.current);
              if (transcript) await pushHostedVoiceMemory({ transcript });
            }
          } catch {
            // Best-effort: never block disconnect on memory.
          }
        }
        await client?.disconnect();
      } finally {
        clientRef.current = null;
        setConnected(false);
        markVoiceOn(false);
        setMuted(false);
        setInputLevel(0);
        setOutputLevel(0);
        setStopping(false);
        stopPromiseRef.current = null;
      }
    })();
    stopPromiseRef.current = pending;
    await pending;
  }, [markVoiceOn, platform.capabilities.voiceMemory]);

  useEffect(() => {
    if (!live || muted) {
      setInputLevel(0);
      return;
    }
    const stream = clientRef.current?.getMicStream();
    if (!stream) {
      setInputLevel(0);
      return;
    }

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.7;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let alive = true;
    let lastPublish = 0;

    const tick = () => {
      if (!alive) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        const v = (samples[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);
      const level = Math.min(1, Math.max(0, (rms - 0.015) * 5.5));
      const now = performance.now();
      if (now - lastPublish >= 40) {
        lastPublish = now;
        setInputLevel(level);
      }
      raf = requestAnimationFrame(tick);
    };

    void audioContext.resume().then(() => {
      if (alive) raf = requestAnimationFrame(tick);
    });

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      source.disconnect();
      void audioContext.close();
      setInputLevel(0);
    };
  }, [live, muted]);

  // Remote WebRTC audio may arrive after connect — poll briefly for the stream.
  useEffect(() => {
    if (!live) {
      setOutputLevel(0);
      return;
    }

    let alive = true;
    let raf = 0;
    let poll = 0;
    let audioContext: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let lastPublish = 0;
    const samples = new Uint8Array(512);

    const attach = (stream: MediaStream) => {
      audioContext = new AudioContext();
      source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);

      const tick = () => {
        if (!alive || !audioContext) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i++) {
          const v = (samples[i]! - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / samples.length);
        const level = Math.min(1, Math.max(0, (rms - 0.01) * 6));
        const now = performance.now();
        if (now - lastPublish >= 40) {
          lastPublish = now;
          setOutputLevel(level);
        }
        raf = requestAnimationFrame(tick);
      };

      void audioContext.resume().then(() => {
        if (alive) raf = requestAnimationFrame(tick);
      });
    };

    const tryAttach = () => {
      if (!alive) return;
      const stream = clientRef.current?.getRemoteAudioStream();
      if (stream) {
        attach(stream);
        return;
      }
      poll = window.setTimeout(tryAttach, 200);
    };
    tryAttach();

    return () => {
      alive = false;
      window.clearTimeout(poll);
      cancelAnimationFrame(raf);
      source?.disconnect();
      void audioContext?.close();
      setOutputLevel(0);
    };
  }, [live]);

  const toggle = useCallback(async () => {
    // A second tap on End arrives while teardown is still running. Reading it as
    // "start a new session" mints a token against a sandbox that is pausing, and
    // the failed fetch surfaces as an error after the user ended the call.
    if (stopping) {
      await stopPromiseRef.current;
      return;
    }
    if (live || connecting) await stop();
    else await start();
  }, [live, connecting, stopping, start, stop]);

  const applyMuted = useCallback((next: boolean) => {
    const client = clientRef.current;
    if (!client) return;
    setMuted(next);
    void client.setMuted(next).then(() => {
      setMuted(client.isMuted());
    }).catch((err) => {
      setMuted(client.isMuted());
      if (!next) setError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  const toggleMute = useCallback(() => {
    const client = clientRef.current;
    if (!client || !live) return;
    const next = !client.isMuted();
    if (!next) playConnectedChime();
    applyMuted(next);
  }, [live, applyMuted]);

  const setMicMuted = useCallback((next: boolean) => {
    if (!voiceOnRef.current) return;
    applyMuted(next);
  }, [applyMuted]);

  const sendText = useCallback((text: string) => {
    const key = openProjectRef.current;
    const title = key ? projectsRef.current.find((project) => project.key === key)?.title : undefined;
    clientRef.current?.sendText(text, key && title ? { key, title } : undefined);
  }, []);

  const injectContext = useCallback((text: string): boolean => {
    return clientRef.current?.injectContext(text) ?? false;
  }, []);

  const syncOpenView = useCallback((target: TileCaptureTarget) => {
    void clientRef.current?.syncOpenView(target);
  }, []);

  const clearOpenView = useCallback(() => {
    clientRef.current?.clearOpenView();
  }, []);

  const resumeAudio = useCallback(() => {
    clientRef.current?.resumeAudio();
  }, []);

  const clearLines = useCallback(() => {
    setLines([]);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const startLook = useCallback(async () => {
    setError(null);
    try {
      await start();
      await clientRef.current!.sendLook();
    } catch (err) {
      setError(captureErrorMessage(err));
    }
  }, [start]);

  useEffect(() => {
    return () => {
      void clientRef.current?.disconnect();
    };
  }, []);

  return useMemo(() => ({
    lines,
    connected: live && !stopping,
    sessionOpen: connected && !stopping,
    connecting,
    muted,
    inputLevel,
    outputLevel,
    toolPulse,
    pendingTool,
    error,
    audioBlocked,
    metered,
    resumeAudio,
    start,
    openSession,
    stop,
    toggle,
    toggleMute,
    setMicMuted,
    setLookCapture,
    setTileCapture,
    startLook,
    sendText,
    injectContext,
    syncOpenView,
    clearOpenView,
    clearLines,
    clearError,
  }), [
    audioBlocked,
    clearError,
    clearLines,
    clearOpenView,
    connected,
    connecting,
    error,
    injectContext,
    inputLevel,
    lines,
    live,
    metered,
    muted,
    openSession,
    outputLevel,
    pendingTool,
    resumeAudio,
    sendText,
    setLookCapture,
    setMicMuted,
    setTileCapture,
    start,
    startLook,
    stop,
    stopping,
    syncOpenView,
    toggle,
    toggleMute,
    toolPulse,
  ]);
}
