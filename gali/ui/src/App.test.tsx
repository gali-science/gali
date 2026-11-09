import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "./App";

const state = vi.hoisted(() => {
  const noop = vi.fn();
  return {
    hosted: false,
    phone: false,
    auth: { isLoaded: true, isSignedIn: true },
    projects: [] as Array<{
      key: string;
      title: string;
      paperPath: string;
      createdAt: string;
      updatedAt: string;
    }>,
    nav: null as null | ((event: unknown) => void),
    navSubscriptions: 0,
    navUnsubscriptions: 0,
    lookConnected: null as null | boolean,
    reviewer: null as null | ((event: unknown) => void),
    ensureSandboxReady: vi.fn(async () => ({ status: "ready" })),
    noop,
    trialAccess: {
      trial: null as null | {
        status: "active" | "exhausted";
        spentUsd: number;
        budgetUsd: number;
        remainingUsd: number;
      },
      trialExhausted: false,
      accessBlocked: false,
      refreshTrial: vi.fn(async () => {}),
    },
    voice: {
      lines: [],
      connected: false,
      sessionOpen: false,
      connecting: false,
      muted: false,
      inputLevel: 0,
      outputLevel: 0,
      error: null,
      toolPulse: 0,
      pendingTool: null,
      audioBlocked: false,
      metered: false,
      start: vi.fn(async () => {}),
      openSession: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      toggle: noop,
      toggleMute: noop,
      setMicMuted: noop,
      setLookCapture: noop,
      setTileCapture: noop,
      startLook: vi.fn(async () => {}),
      clearError: noop,
      sendText: vi.fn(),
      injectContext: vi.fn(() => true),
      syncOpenView: noop,
      clearOpenView: noop,
      resumeAudio: noop,
      clearLines: noop,
    },
  };
});

vi.mock("./auth", () => ({
  useGaliAuth: () => ({ ...state.auth, signOut: vi.fn(async () => {}) }),
}));
vi.mock("./account", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./account")>();
  return {
    ...actual,
    getModelConsent: vi.fn(async () => ({
      version: 1,
      accepted: true,
      voiceOpenAiAccepted: true,
      experimentsTogetherAccepted: true,
      acceptedAt: new Date().toISOString(),
    })),
    acceptModelConsent: vi.fn(),
  };
});
vi.mock("./platform/context", () => ({
  usePlatform: () => ({
    mode: state.hosted ? "hosted" : "none",
    client: null,
    capabilities: {
      trialMetering: state.hosted,
      sandboxWake: state.hosted,
      downloadFiles: state.hosted,
      voiceMemory: state.hosted ? "hosted" : "none",
    },
    boot: {
      ensureReady: () => state.ensureSandboxReady(),
      isAuthRequired: () => false,
    },
    workspace: { current: () => ({ state: "ok" }), subscribe: () => () => {} },
  }),
}));
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    listProjects: vi.fn(async () => state.projects),
    onNavEvent: (cb: (event: unknown) => void) => {
      state.navSubscriptions += 1;
      state.nav = cb;
      return () => {
        state.navUnsubscriptions += 1;
        state.nav = null;
      };
    },
    onReviewerEvent: (cb: (event: unknown) => void) => {
      state.reviewer = cb;
      return () => {
        state.reviewer = null;
      };
    },
    onProjectEvent: () => state.noop,
    onBackendRestart: () => state.noop,
  };
});
vi.mock("./useVoice", () => ({ useVoice: () => state.voice }));
vi.mock("./app/use-look-capture", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app/use-look-capture")>();
  return {
    useLookCapture: (input: Parameters<typeof actual.useLookCapture>[0]) => {
      state.lookConnected = input.connected;
      return actual.useLookCapture(input);
    },
  };
});
vi.mock("./useTrial", () => ({
  useTrial: () => state.trialAccess,
}));
vi.mock("./features/projects/ProjectWorkspace", () => ({
  ProjectWorkspace: ({
    projectKey,
    reviewerBusy,
    navigationCommand,
    bar,
    onOpenAccount,
  }: {
    projectKey: string;
    reviewerBusy: boolean;
    navigationCommand: { type: string; tab?: string } | null;
    bar: React.ReactNode;
    onOpenAccount?: () => void;
  }) => (
    <div>
      <div>{`Workspace ${projectKey}${reviewerBusy ? " · reviewer busy" : ""}`}</div>
      {onOpenAccount ? <button type="button" onClick={onOpenAccount}>Workspace account</button> : null}
      <div data-testid="workspace-bar">{bar}</div>
      <div data-testid="workspace-state">
        {navigationCommand ? `${navigationCommand.type}:${navigationCommand.tab ?? ""}` : ""}
      </div>
    </div>
  ),
}));
vi.mock("./features/projects/NewPaperDialog", () => ({
  NewPaperDialog: ({ initialTitle }: { initialTitle?: string }) => (
    <div role="dialog" aria-label="Add to library">{initialTitle ?? ""}</div>
  ),
}));
vi.mock("./features/account/AccountPage", () => ({
  AccountPage: ({ onGoHome }: { onGoHome?: () => void }) => (
    <div>
      Account settings
      {onGoHome ? <button type="button" onClick={onGoHome}>Back to Home</button> : null}
    </div>
  ),
}));
vi.mock("./features/boot/LoginScreen", () => ({
  LoginScreen: () => <div>Sign in to continue</div>,
}));
vi.mock("./features/voice/VoiceIsland", () => ({
  VoiceIsland: (props: {
    onSend?: (text: string) => Promise<void>;
    onLook?: () => void;
    lookDisabled?: boolean;
  }) => {
    const { onSend, onLook, lookDisabled } = props;
    return (
      <div>
        <span>{"reviewerBusy" in props ? "Island with reviewer" : "Island"}</span>
        {onLook ? <button type="button" disabled={lookDisabled} onClick={onLook}>Look</button> : null}
        {onSend ? (
          <button type="button" onClick={() => void onSend("what data do they use?")}>Send typed</button>
        ) : null}
      </div>
    );
  },
}));

const alpha = {
  key: "alpha",
  title: "Alpha",
  paperPath: "paper/alpha.pdf",
  createdAt: "2026-09-18T12:00:00.000Z",
  updatedAt: "2026-09-18T12:00:00.000Z",
};

const exhausted = {
  trial: { status: "exhausted" as const, spentUsd: 10, budgetUsd: 10, remainingUsd: 0 },
  trialExhausted: true,
  accessBlocked: true,
  refreshTrial: vi.fn(async () => {}),
};

async function finishBoot() {
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(3_000);
  });
  void act(() => vi.advanceTimersByTime(500));
}

beforeEach(() => {
  vi.useFakeTimers();
  HTMLElement.prototype.scrollTo = state.noop;
  state.hosted = false;
  state.phone = false;
  state.auth = { isLoaded: true, isSignedIn: true };
  state.projects = [];
  state.nav = null;
  state.navSubscriptions = 0;
  state.navUnsubscriptions = 0;
  state.reviewer = null;
  state.ensureSandboxReady.mockReset();
  state.ensureSandboxReady.mockResolvedValue({ status: "ready" });
  state.trialAccess = {
    trial: null,
    trialExhausted: false,
    accessBlocked: false,
    refreshTrial: vi.fn(async () => {}),
  };
  state.voice = { ...state.voice, connected: false, sessionOpen: false, connecting: false, metered: false, outputLevel: 0 };
  state.voice.stop.mockClear();
  state.voice.start.mockClear();
  state.voice.openSession.mockClear();
  state.voice.sendText.mockClear();
  state.voice.injectContext.mockClear();
  state.voice.startLook.mockClear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: state.phone,
      addEventListener: state.noop,
      removeEventListener: state.noop,
    }),
  });
});

describe("App shell", () => {
  test("boots to the new-project drop page with the project sidebar", async () => {
    render(<App />);
    await finishBoot();
    expect(screen.getByRole("heading", { name: "Drop a PDF and its code" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Projects" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
    expect(screen.getByText("Island")).toBeTruthy();
  });

  test("Choose files on the drop page opens the Add to library dialog", async () => {
    render(<App />);
    await finishBoot();
    expect(screen.queryByRole("dialog", { name: "Add to library" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose files" }));
    expect(screen.getByRole("dialog", { name: "Add to library" })).toBeTruthy();
  });

  test("shows authentication instead of mounting the hosted shell", async () => {
    state.hosted = true;
    state.auth = { isLoaded: true, isSignedIn: false };
    render(<App />);
    await act(async () => Promise.resolve());
    expect(screen.getByText("Sign in to continue")).toBeTruthy();
    expect(screen.queryByText("Drop a PDF and its code")).toBeNull();
  });

  test("opens a project from voice and shows the reviewer as busy in the workspace, not the pill", async () => {
    state.projects = [alpha];
    render(<App />);
    await finishBoot();

    act(() => state.nav?.({ type: "open_project", projectKey: "alpha" }));
    expect(screen.getByText("Workspace alpha")).toBeTruthy();
    act(() => state.reviewer?.({ type: "reviewer.started", projectKey: "alpha", seq: 1 }));
    expect(screen.getByText("Workspace alpha · reviewer busy")).toBeTruthy();
    expect(within(screen.getByTestId("workspace-bar")).getByText("Island")).toBeTruthy();
  });

  test("voice opens the Add to library dialog with a title", async () => {
    render(<App />);
    await finishBoot();
    act(() => state.nav?.({ type: "open_new_project", title: "Attention" }));
    expect(screen.getByRole("dialog", { name: "Add to library" }).textContent).toBe("Attention");
  });

  test("uses the phone home and opens the chat from the bottom bar, not the action sheet", async () => {
    state.phone = true;
    state.projects = [alpha];
    render(<App />);
    await finishBoot();

    expect(screen.getByText("Alpha")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Account"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    const chat = screen.getByTitle("Chat");
    fireEvent.click(chat);
    expect(screen.getByTitle("Close chat")).toBeTruthy();
    expect(chat.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chat);
    expect(chat.getAttribute("aria-pressed")).toBe("false");
  });

  test("on a phone Gali cannot open screen selection, and the mic is left alone", async () => {
    const setLookCapture = vi.fn();
    const setMicMuted = vi.fn();
    const voice = state.voice;
    state.voice = { ...voice, setLookCapture, setMicMuted };
    try {
      state.phone = true;
      render(<App />);
      await finishBoot();
      const look = setLookCapture.mock.calls.map(([handler]) => handler).filter(Boolean).at(-1) as () => Promise<unknown>;
      await expect(look()).resolves.toEqual({ status: "failed", error: "Screen selection is not available on phone." });
      expect(setMicMuted).not.toHaveBeenCalled();
      expect(document.querySelector(".region-select-overlay")).toBeNull();
    } finally {
      state.voice = voice;
    }
  });

  test.each([false, true])("opens Account when phone is %s", async (phone) => {
    state.phone = phone;
    state.projects = [alpha];
    render(<App />);
    await finishBoot();

    if (phone) {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Account" }));
    } else {
      fireEvent.click(screen.getByRole("button", { name: "Account" }));
    }
    expect(screen.getByText("Account settings")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to Home" }) !== null).toBe(!phone);
  });

  test.each([false, true])("the rail is only the phone's bottom bar when phone is %s", async (phone) => {
    state.phone = phone;
    const view = render(<App />);
    await finishBoot();
    expect(view.container.querySelector(".rail") !== null).toBe(phone);
  });

  test("desktop Account leads back Home", async () => {
    state.projects = [alpha];
    render(<App />);
    await finishBoot();
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to Home" }));
    expect(screen.queryByText("Account settings")).toBeNull();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });

  test("in a paper, Look is in the Gali bar and Account is in the paper's menu", async () => {
    state.projects = [alpha];
    render(<App />);
    await finishBoot();
    act(() => state.nav?.({ type: "open_project", projectKey: "alpha" }));
    const look = within(screen.getByTestId("workspace-bar")).getByRole("button", { name: "Look" }) as HTMLButtonElement;
    expect(look.disabled).toBe(false);
    fireEvent.click(look);
    expect(state.voice.startLook).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Workspace account" }));
    expect(screen.getByText("Account settings")).toBeTruthy();
  });

  test("Look in the Gali bar is off while the trial is spent", async () => {
    state.projects = [alpha];
    state.trialAccess = exhausted;
    render(<App />);
    await finishBoot();
    act(() => state.nav?.({ type: "open_project", projectKey: "alpha" }));
    const look = within(screen.getByTestId("workspace-bar")).getByRole("button", { name: "Look" }) as HTMLButtonElement;
    expect(look.disabled).toBe(true);
  });

  test("does not rebind navigation subscriptions on output-level updates", async () => {
    const view = render(<App />);
    await finishBoot();
    expect(state.navSubscriptions).toBe(1);
    state.voice = { ...state.voice, outputLevel: 0.7 };
    view.rerender(<App />);
    expect(state.navSubscriptions).toBe(1);
    expect(state.navUnsubscriptions).toBe(0);
  });

  test.each([false, true])("an exhausted trial shows one notice and a banner when phone is %s", async (phone) => {
    state.phone = phone;
    state.trialAccess = exhausted;
    render(<App />);
    await finishBoot();

    expect(screen.getAllByRole("dialog", { name: "Your trial is spent" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog", { name: "Your trial is spent" })).toBeNull();
    expect(screen.getByText("Trial spent. Your work stays here.")).toBeTruthy();
  });

  test("stops active voice when the trial is exhausted", async () => {
    state.trialAccess = exhausted;
    state.voice = { ...state.voice, connected: true, metered: true };
    render(<App />);
    await act(async () => Promise.resolve());
    expect(state.voice.stop).toHaveBeenCalledOnce();
  });

  test("stops a typed-only session when the trial is exhausted", async () => {
    state.trialAccess = exhausted;
    state.voice = { ...state.voice, sessionOpen: true, metered: true };
    render(<App />);
    await act(async () => Promise.resolve());
    expect(state.voice.stop).toHaveBeenCalledOnce();
  });

  test("inside a paper the Gali bar docks in the workspace and the floating chips are gone", async () => {
    state.projects = [alpha];
    render(<App />);
    await finishBoot();
    act(() => state.nav?.({ type: "open_project", projectKey: "alpha" }));

    expect(screen.getAllByText(/^Island/)).toHaveLength(1);
    expect(screen.getByTestId("workspace-bar").textContent).toContain("Island");
    expect(screen.queryByText("Summarize this PDF")).toBeNull();
  });

  test("a look Gali asks for in a typed session is not cancelled for lack of voice", async () => {
    state.voice = { ...state.voice, connected: false, sessionOpen: true };
    render(<App />);
    await finishBoot();
    expect(state.lookConnected).toBe(true);
  });

  test("a typed question opens a session without voice, shares the location first, and shows the Chat tab", async () => {
    state.projects = [alpha];
    render(<App />);
    await finishBoot();
    act(() => state.nav?.({ type: "open_project", projectKey: "alpha" }));
    state.voice.injectContext.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send typed" }));
    });

    expect(state.voice.openSession).toHaveBeenCalledOnce();
    expect(state.voice.start).not.toHaveBeenCalled();
    expect(state.voice.injectContext).toHaveBeenCalledWith(expect.stringContaining('in project "Alpha"'));
    expect(state.voice.sendText).toHaveBeenCalledWith("what data do they use?");
    expect(state.voice.injectContext.mock.invocationCallOrder[0]!).toBeLessThan(
      state.voice.sendText.mock.invocationCallOrder[0]!,
    );
    expect(screen.getByTestId("workspace-state").textContent).toContain("show-tab:chat");
  });

  test("a typed question with a spent trial opens the key prompt instead", async () => {
    state.projects = [alpha];
    state.trialAccess = exhausted;
    render(<App />);
    await finishBoot();
    act(() => state.nav?.({ type: "open_project", projectKey: "alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("dialog", { name: "Your trial is spent" })).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send typed" }));
    });
    expect(state.voice.openSession).not.toHaveBeenCalled();
    expect(state.voice.sendText).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Your trial is spent" })).toBeTruthy();
  });
});
