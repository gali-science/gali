import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const connect = vi.fn();
const disconnect = vi.fn();
const setMutedMock = vi.fn();
const startVoiceMock = vi.fn();
const sendTextMock = vi.fn();
let latestOnEvent: ((event: unknown) => void) | null = null;

let holdDisconnect = false;
let releaseDisconnect: (() => void) | null = null;
let holdAfterOpen = false;
let releaseConnect: (() => void) | null = null;

vi.mock("./realtime-client", () => ({
  VoiceScientist: class {
    cb: {
      onConnected?: (c: boolean) => void;
      onMetered?: (metered: boolean) => void;
    };
    constructor(cb: {
      onEvent?: (event: unknown) => void;
      onConnected?: (c: boolean) => void;
      onMetered?: (metered: boolean) => void;
    }) {
      this.cb = cb;
      latestOnEvent = cb.onEvent ?? null;
    }
    sendText(text: string, project?: unknown) {
      sendTextMock(text, project);
    }
    async connect(voice?: boolean) {
      await connect(voice);
      this.cb.onMetered?.(true);
      this.cb.onConnected?.(true);
      if (holdAfterOpen) {
        await new Promise<void>((resolve) => {
          releaseConnect = resolve;
        });
      }
    }
    async startVoice() {
      await startVoiceMock();
    }
    async disconnect() {
      disconnect();
      if (!holdDisconnect) {
        this.cb.onMetered?.(false);
        return;
      }
      await new Promise<void>((resolve) => {
        releaseDisconnect = resolve;
      });
      this.cb.onMetered?.(false);
    }
    muted = false;
    async setMuted(muted: boolean) {
      await setMutedMock(muted);
      this.muted = muted;
    }
    isMuted() {
      return this.muted;
    }
    setTourLocked() {}
    setLookHandler() {}
    setTileCaptureHandler() {}
    getMicStream() {
      return null;
    }
    getRemoteAudioStream() {
      return null;
    }
    async summarizeMemory() {
      return null;
    }
  },
}));

vi.mock("./http-bridge", () => ({ httpBridgeEnabled: () => false }));
vi.mock("./platform/context", () => ({
  usePlatform: () => ({
    client: {},
    capabilities: { voiceMemory: "local" },
  }),
}));
vi.mock("./api", () => ({ saveVoiceMemory: vi.fn() }));
vi.mock("./voice-memory", () => ({
  buildTranscript: () => "",
  pushHostedVoiceMemory: vi.fn(),
}));

const { useVoice } = await import("./useVoice");

beforeEach(() => {
  connect.mockReset();
  connect.mockResolvedValue(undefined);
  disconnect.mockReset();
  setMutedMock.mockReset();
  setMutedMock.mockResolvedValue(undefined);
  startVoiceMock.mockReset();
  startVoiceMock.mockResolvedValue(undefined);
  holdDisconnect = false;
  releaseDisconnect = null;
  holdAfterOpen = false;
  releaseConnect = null;
});

describe("useVoice", () => {
  test("each chat line belongs to the project it is about: its own key, the tool's project, or the open project", async () => {
    const projects = [{ key: "a", title: "Alpha" }, { key: "b", title: "Beta" }];
    const { result, rerender } = renderHook(({ open }) => useVoice(() => {}, undefined, false, projects, open), {
      initialProps: { open: "a" as string | null },
    });
    await act(async () => {
      await result.current.toggle();
    });

    act(() => {
      latestOnEvent?.({ kind: "message", role: "user", text: "typed in a" });
      latestOnEvent?.({ kind: "tool", name: "ask_reviewer", args: { projectKey: "b", question: "q" }, result: { asked: true } });
      latestOnEvent?.({ kind: "status", text: "Answer ready on b", projectKey: "b" });
      latestOnEvent?.({ kind: "message", role: "assistant", text: "about b", projectKey: "b" });
      latestOnEvent?.({ kind: "tool", name: "open_project", args: { query: "beta" }, result: { opened: true, project: { key: "b", title: "Beta" } } });
    });
    rerender({ open: null });
    act(() => {
      latestOnEvent?.({ kind: "message", role: "user", text: "on home" });
    });

    expect(result.current.lines.map((line) => [line.kind === "tool" ? line.name : line.text, line.projectKey])).toEqual([
      ["typed in a", "a"],
      ["ask_reviewer", "b"],
      ["Answer ready on b", "b"],
      ["about b", "b"],
      ["open_project", "b"],
      ["on home", undefined],
    ]);
  });

  test("typed text carries the open project's key and title, and none on Home", async () => {
    const projects = [{ key: "a", title: "Alpha" }];
    const { result, rerender } = renderHook(({ open }) => useVoice(() => {}, undefined, false, projects, open), {
      initialProps: { open: "a" as string | null },
    });
    await act(async () => {
      await result.current.toggle();
    });
    sendTextMock.mockClear();

    result.current.sendText("is it right?");
    rerender({ open: null });
    result.current.sendText("hello");

    expect(sendTextMock.mock.calls).toEqual([
      ["is it right?", { key: "a", title: "Alpha" }],
      ["hello", undefined],
    ]);
  });

  test("a second End tap during teardown does not start a new session", async () => {
    holdDisconnect = true;
    const { result } = renderHook(() => useVoice(() => {}));

    await act(async () => {
      await result.current.toggle();
    });
    expect(connect).toHaveBeenCalledTimes(1);

    let firstTap: Promise<void> | undefined;
    await act(async () => {
      firstTap = result.current.toggle();
    });
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));

    let secondTap: Promise<void> | undefined;
    await act(async () => {
      secondTap = result.current.toggle();
    });

    expect(connect).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseDisconnect?.();
      await Promise.all([firstTap, secondTap]);
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  test("ending the session clears an error raised during the call", async () => {
    const { result } = renderHook(() => useVoice(() => {}));
    await act(async () => {
      await result.current.toggle();
    });

    // A failed unmute is the one in-call action that reports to the banner.
    setMutedMock.mockRejectedValueOnce(new Error("No microphone track available."));
    await act(async () => {
      result.current.setMicMuted(false);
    });
    await waitFor(() =>
      expect(result.current.error).toBe("No microphone track available."),
    );

    await act(async () => {
      await result.current.toggle();
    });

    expect(result.current.error).toBeNull();
  });

  test("a failed fetch is reported as a workspace that is still waking up", async () => {
    connect.mockRejectedValueOnce(
      new TypeError("NetworkError when attempting to fetch resource."),
    );
    const { result } = renderHook(() => useVoice(() => {}));

    await act(async () => {
      await result.current.toggle().catch(() => {});
    });

    expect(result.current.error).toBe(
      "Couldn't reach your workspace — it may still be waking up. Try again.",
    );
  });

  test("does not connect when the trial blocks a start", async () => {
    const onStartBlocked = vi.fn();
    const { result } = renderHook(() =>
      useVoice(() => {}, { canStart: () => false, onStartBlocked }),
    );
    await expect(result.current.start()).rejects.toThrow(/trial is spent/);
    expect(onStartBlocked).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });

  test("reports whether the current voice session uses the platform key", async () => {
    const { result } = renderHook(() => useVoice(() => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.metered).toBe(true);
    await act(async () => {
      await result.current.stop();
    });
    expect(result.current.metered).toBe(false);
  });

  test("typing opens a session without voice, and play turns voice on in that session", async () => {
    const { result } = renderHook(() => useVoice(() => {}));
    await act(async () => {
      await result.current.openSession();
    });
    expect(connect).toHaveBeenCalledWith(false);
    expect(result.current.sessionOpen).toBe(true);
    expect(result.current.connected).toBe(false);

    await act(async () => {
      await result.current.toggle();
    });
    expect(connect).toHaveBeenCalledTimes(1);
    expect(startVoiceMock).toHaveBeenCalledOnce();
    expect(result.current.connected).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
  });

  test("a mic error while turning voice on keeps the typed session open", async () => {
    startVoiceMock.mockRejectedValueOnce(new Error("Permission denied"));
    const { result } = renderHook(() => useVoice(() => {}));
    await act(async () => {
      await result.current.openSession();
    });
    await act(async () => {
      await result.current.start().catch(() => {});
    });
    expect(result.current.error).toMatch(/Microphone blocked/);
    expect(result.current.sessionOpen).toBe(true);
    expect(result.current.connected).toBe(false);
  });

  test("a typed session never touches the mic when something asks to unmute", async () => {
    const { result } = renderHook(() => useVoice(() => {}));
    await act(async () => {
      await result.current.openSession();
    });
    await act(async () => {
      result.current.setMicMuted(true);
      result.current.setMicMuted(false);
    });
    expect(setMutedMock).not.toHaveBeenCalled();
  });

  test("Talk shows live as soon as the channel opens, before connect finishes", async () => {
    holdAfterOpen = true;
    const { result } = renderHook(() => useVoice(() => {}));
    let started: Promise<void> | undefined;
    await act(async () => {
      started = result.current.start();
    });
    await waitFor(() => expect(releaseConnect).not.toBeNull());
    expect(result.current.connected).toBe(true);
    await act(async () => {
      releaseConnect?.();
      await started;
    });
    expect(result.current.connected).toBe(true);
  });

  test("Talk still opens a voice session directly", async () => {
    const { result } = renderHook(() => useVoice(() => {}));
    await act(async () => {
      await result.current.start();
    });
    expect(connect).toHaveBeenCalledWith(true);
    expect(startVoiceMock).not.toHaveBeenCalled();
    expect(result.current.connected).toBe(true);
  });
});
