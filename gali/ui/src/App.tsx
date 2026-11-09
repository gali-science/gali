import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { acceptModelConsent, getModelConsent } from "./account";
import { listProjects, type ProjectDto } from "./api";
import { useGaliAuth } from "./auth";
import { Chat } from "./Chat";
import { AccountPage } from "./features/account/AccountPage";
import { BootScreen } from "./features/boot/BootScreen";
import { LoginScreen } from "./features/boot/LoginScreen";
import { ModelConsentScreen } from "./features/boot/ModelConsentScreen";
import { NewPaperDialog } from "./features/projects/NewPaperDialog";
import { ProjectWorkspace } from "./features/projects/ProjectWorkspace";
import { captureTileView } from "./features/projects/view-capture";
import { TrialKeyPrompt } from "./features/runtime/TrialKeyPrompt";
import { RegionSelectOverlay } from "./features/voice/RegionSelectOverlay";
import { VoiceIsland } from "./features/voice/VoiceIsland";
import { usePlatform } from "./platform/context";
import { useVoice } from "./useVoice";
import { useTrial } from "./useTrial";
import { AppRail } from "./app/AppRail";
import { AppVoiceBar } from "./app/AppVoiceBar";
import { useBootSequence } from "./app/use-boot-sequence";
import { deriveVoiceChrome } from "./app/voice-chrome";
import { MobileProjectsRoster } from "./app/project-rosters";
import { ProjectSidebar } from "./app/ProjectSidebar";
import { NewProjectDrop } from "./features/projects/NewProjectDrop";
import { useUiLocationSync } from "./app/use-ui-location-sync";
import { useProjectChat } from "./app/use-project-chat";
import { useLookCapture } from "./app/use-look-capture";
import {
  useAppNavigation,
  useAppNavigationEffects,
} from "./app/navigation-coordinator";
import { useReviewerBusy } from "./app/use-reviewer-busy";
import { usePhoneShell } from "./hooks/use-phone-shell";
import { useWorkspaceHealth, WorkspaceHealthBanner } from "./app/workspace-health";

export function App() {
  const platform = usePlatform();
  const { isLoaded: authLoaded, isSignedIn, signOut } = useGaliAuth();
  const requiresModelConsent = platform.capabilities.sandboxWake;
  const [consentLoaded, setConsentLoaded] = useState(!requiresModelConsent);
  const [consentAccepted, setConsentAccepted] = useState(!requiresModelConsent);
  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  useEffect(() => {
    if (!requiresModelConsent) {
      setConsentLoaded(true);
      setConsentAccepted(true);
      return;
    }
    if (!authLoaded) return;
    if (!isSignedIn) {
      setConsentLoaded(true);
      setConsentAccepted(false);
      setConsentError(null);
      return;
    }
    let cancelled = false;
    setConsentLoaded(false);
    void getModelConsent()
      .then((consent) => {
        if (!cancelled) {
          setConsentAccepted(Boolean(consent?.accepted));
          setConsentError(null);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setConsentAccepted(false);
          setConsentError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setConsentLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authLoaded, isSignedIn, requiresModelConsent]);
  const acceptConsent = useCallback(() => {
    setConsentBusy(true);
    setConsentError(null);
    void acceptModelConsent()
      .then(() => setConsentAccepted(true))
      .catch((cause) => {
        setConsentError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setConsentBusy(false));
  }, []);
  const bootAuthLoaded = authLoaded && (!isSignedIn || consentLoaded);
  const bootSignedIn = isSignedIn && consentAccepted;
  const phone = usePhoneShell();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const navigation = useAppNavigation();
  const {
    selectedProjectKey: selected,
    shellPage,
    chatOpen,
    newPaper,
    workspaceCommand,
    dispatchUiNavigation,
  } = navigation;
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => {
    return listProjects().then(setProjects);
  }, []);
  const { backend, backendError, bootPhase, wakePhase, retryBoot } = useBootSequence({
    authLoaded: bootAuthLoaded,
    isSignedIn: bootSignedIn,
    load: refresh,
  });
  const bump = useCallback(() => {
    setRefreshKey((k) => k + 1);
    void refresh();
  }, [refresh]);

  const trial = useTrial({
    enabled: platform.capabilities.trialMetering && bootAuthLoaded && bootSignedIn,
    polling: true,
  });
  const {
    accessBlocked,
    trial: trialStatus,
    trialExhausted,
  } = trial;
  const [trialKeyPrompt, setTrialKeyPrompt] = useState(false);
  const openTrialKeyPrompt = useCallback(() => {
    setTrialKeyPrompt(true);
  }, []);
  const voiceTrial = useMemo(
    () => ({
      canStart: () => !accessBlocked,
      onStartBlocked: openTrialKeyPrompt,
    }),
    [accessBlocked, openTrialKeyPrompt],
  );
  const voice = useVoice(bump, voiceTrial, phone, projects, selected);
  const {
    connected: voiceConnected,
    sessionOpen: voiceSessionOpen,
    connecting: voiceConnecting,
    stop: stopVoice,
    setTileCapture,
    toggle: toggleVoice,
    toggleMute,
    start: startVoice,
    openSession: openVoiceSession,
    sendText: sendVoiceText,
  } = voice;
  const blockedRef = useRef(false);
  useEffect(() => {
    if (accessBlocked && !blockedRef.current) openTrialKeyPrompt();
    blockedRef.current = accessBlocked;
    if (accessBlocked && (voiceConnected || voiceSessionOpen || voiceConnecting)) {
      void stopVoice();
    }
  }, [
    accessBlocked,
    openTrialKeyPrompt,
    stopVoice,
    voiceConnected,
    voiceSessionOpen,
    voiceConnecting,
  ]);
  const closeTrialKeyPrompt = useCallback(() => {
    setTrialKeyPrompt(false);
  }, []);
  const { audioBlocked, resumeAudio } = voice;
  useEffect(() => {
    if (!audioBlocked) return;
    const unlock = () => resumeAudio();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, [audioBlocked, resumeAudio]);

  const {
    capture: lookCapture,
    phoneNotice,
    setPhoneNotice,
    finish: finishLook,
  } = useLookCapture({
    phone,
    connected: voice.sessionOpen,
    muted: voice.muted,
    setMicMuted: voice.setMicMuted,
    setLookCapture: voice.setLookCapture,
  });

  useAppNavigationEffects({
    navigation,
    phone,
    lookOpen: lookCapture !== null,
    finishLook,
    voice,
    bump,
  });

  useEffect(() => {
    setTileCapture(captureTileView);
    return () => setTileCapture(null);
  }, [setTileCapture]);

  const reviewerBusyByProject = useReviewerBusy();
  const reviewerBusy = selected ? (reviewerBusyByProject[selected] ?? 0) > 0 : false;

  const project = projects.find((p) => p.key === selected);
  const chatLines = useProjectChat(project?.key ?? null, voice.lines);

  const [workspaceView, setWorkspaceView] = useState<{ key: string; view: string } | null>(null);
  const syncUiLocation = useUiLocationSync({
    project,
    shellPage,
    workspaceView,
    connected: voice.sessionOpen,
    injectContext: voice.injectContext,
  });

  const goHome = useCallback(() => {
    dispatchUiNavigation({ type: "open-home" });
  }, [dispatchUiNavigation]);

  const goAccount = useCallback(() => {
    dispatchUiNavigation({ type: "open-shell-page", page: "account" });
  }, [dispatchUiNavigation]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditable(event.target)) return;

      if (event.code === "Space") {
        event.preventDefault();
        if (lookCapture) return;
        if (accessBlocked && !voiceConnected && !voiceConnecting) {
          openTrialKeyPrompt();
          return;
        }
        void toggleVoice();
        return;
      }

      if (event.code === "KeyM") {
        event.preventDefault();
        toggleMute();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    accessBlocked,
    lookCapture,
    openTrialKeyPrompt,
    toggleMute,
    toggleVoice,
    voiceConnected,
    voiceConnecting,
  ]);
  const {
    state: voiceState,
    label: voiceLabel,
    echo: voiceEcho,
    chips: voiceChips,
  } = deriveVoiceChrome({
    talkChrome: false,
    error: voice.error,
    connecting: voice.connecting,
    connected: voice.connected,
    muted: voice.muted,
    pendingTool: voice.pendingTool,
    lines: voice.lines,
    reviewerBusy,
    trialBlocked: accessBlocked,
    selectedProjectKey: selected,
    projects,
  });

  const sendChip = useCallback(
    async (text: string) => {
      if (accessBlocked) {
        openTrialKeyPrompt();
        return;
      }
      if (!voiceConnected) await startVoice();
      sendVoiceText(text);
    },
    [
      accessBlocked,
      openTrialKeyPrompt,
      sendVoiceText,
      startVoice,
      voiceConnected,
    ],
  );

  const sendTyped = useCallback(
    async (text: string) => {
      if (accessBlocked) {
        openTrialKeyPrompt();
        return;
      }
      if (selected) {
        dispatchUiNavigation({
          type: "workspace",
          projectKey: selected,
          command: { type: "show-tab", tab: "chat" },
        });
      }
      await openVoiceSession();
      syncUiLocation();
      sendVoiceText(text);
    },
    [
      accessBlocked,
      dispatchUiNavigation,
      openTrialKeyPrompt,
      openVoiceSession,
      selected,
      sendVoiceText,
      syncUiLocation,
    ],
  );

  const openNewPaper = useCallback(() => {
    if (accessBlocked) {
      openTrialKeyPrompt();
      return;
    }
    dispatchUiNavigation({ type: "open-new-paper" });
  }, [accessBlocked, dispatchUiNavigation, openTrialKeyPrompt]);

  const phoneBanner = phone ? (voice.error || phoneNotice) : null;
  const workspaceHealth = useWorkspaceHealth();
  const chatInTab = !phone && project !== undefined;
  const chatProps = {
    onClose: () => dispatchUiNavigation({ type: "close-chat" }),
    lines: chatLines,
    sendText: sendChip,
    phoneEmptyCopy: phone,
    projects,
  };
  const chat = <Chat open={chatOpen} {...chatProps} />;
  const islandProps = {
    connected: voice.connected,
    connecting: voice.connecting,
    muted: voice.muted,
    error: voice.error,
    inputLevel: voice.inputLevel,
    outputLevel: voice.outputLevel,
    pendingTool: voice.pendingTool,
    toolPulse: voice.toolPulse,
    disabled: accessBlocked,
    onToggle: () => void voice.toggle(),
    onMute: voice.toggleMute,
    onClearError: voice.clearError,
  };

  const shell = (
    <div className={`app${phone ? " phone-app" : ""}`}>
      <div
        className={`shell${phone ? "" : " has-sidebar"}${chatOpen && !chatInTab ? " chat-open" : ""}${phone && (voice.connected || voice.connecting) ? " voice-live" : ""}`}
      >
        {phone ? null : (
          <ProjectSidebar
            projects={projects}
            selectedProjectKey={project?.key ?? null}
            accountOpen={!project && shellPage === "account"}
            onNew={goHome}
            onOpen={(projectKey) => dispatchUiNavigation({ type: "open-project", projectKey })}
            onOpenAccount={goAccount}
          />
        )}
        {phoneBanner ? (
          <div className="phone-voice-banner" role="alert">
            <p className="phone-voice-banner-text">{phoneBanner}</p>
            <div className="phone-voice-banner-actions">
              {phoneNotice && !voice.error ? (
                <button
                  type="button"
                  className="phone-voice-banner-btn"
                  onClick={() => {
                    setPhoneNotice(null);
                    void voice.startLook();
                  }}
                >
                  Retake
                </button>
              ) : null}
              <button
                type="button"
                className="phone-voice-banner-btn"
                onClick={() => {
                  setPhoneNotice(null);
                  voice.clearError();
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}
        <WorkspaceHealthBanner onRecovered={bump} />
        {accessBlocked && !trialKeyPrompt && workspaceHealth.state !== "unavailable" ? (
          <div className="trial-block-banner" role="status">
            <span>Trial spent. Your work stays here.</span>
          </div>
        ) : null}
        {phone ? (
          <AppRail
            selectedProjectKey={selected}
            shellPage={shellPage}
            chatOpen={chatOpen}
            connected={voice.connected}
            connecting={voice.connecting}
            muted={voice.muted}
            onGoHome={goHome}
            onToggleChat={() => dispatchUiNavigation({ type: "toggle-chat" })}
            onToggleMute={voice.toggleMute}
            onToggleVoice={() => void voice.toggle()}
          />
        ) : null}

        <div className="shell-main">
          <main className="main">
            {project ? (
              <ProjectWorkspace
                projectKey={project.key}
                refreshKey={refreshKey}
                navigationCommand={workspaceCommand}
                reviewerBusy={reviewerBusy}
                onGoHome={goHome}
                onOpenAccount={goAccount}
                onDeleted={() => {
                  dispatchUiNavigation({
                    type: "project-deleted",
                    projectKey: project.key,
                  });
                  // Drop the project locally right away — the roster mounts
                  // before the refresh lands, and its per-card fetches would
                  // 500 against the just-deleted project.
                  setProjects((ps) => ps.filter((p) => p.key !== project.key));
                  void bump();
                }}
                onViewChange={(view) => setWorkspaceView({ key: project.key, view })}
                onTileSettled={voice.syncOpenView}
                onTileDismissed={voice.clearOpenView}
                chat={chatInTab ? <Chat open embedded {...chatProps} /> : null}
                bar={chatInTab ? (
                  <VoiceIsland
                    {...islandProps}
                    onSend={sendTyped}
                    onLook={() => void voice.startLook()}
                    lookDisabled={accessBlocked || lookCapture !== null || voice.connecting}
                  />
                ) : null}
              />
            ) : shellPage === "account" ? (
              <AccountPage onGoHome={phone ? undefined : goHome} />
            ) : phone ? (
              <MobileProjectsRoster
                projects={projects}
                onOpen={(projectKey) => {
                  dispatchUiNavigation({ type: "open-project", projectKey });
                }}
                onNewPaper={openNewPaper}
                onOpenAccount={goAccount}
              />
            ) : (
              <NewProjectDrop
                onCreated={(created) => {
                  dispatchUiNavigation({ type: "paper-created", projectKey: created.key });
                  bump();
                }}
                onChooseFiles={openNewPaper}
              />
            )}
          </main>

          {chatInTab ? null : chat}
        </div>

        {!phone && !chatInTab && (
          <VoiceIsland
            {...islandProps}
            pinned={!project && shellPage === "home" && projects.length === 0}
          />
        )}

        <AppVoiceBar
          phone={phone}
          state={voiceState}
          label={voiceLabel}
          echo={voiceEcho}
          chips={chatInTab ? [] : voiceChips}
          reviewerBusy={reviewerBusy}
          talkChrome={false}
          connected={voice.connected}
          connecting={voice.connecting}
          muted={voice.muted}
          error={voice.error}
          outputLevel={voice.outputLevel}
          toolPulse={voice.toolPulse}
          trialBlocked={accessBlocked}
          onSendChip={(chip) => void sendChip(chip)}
          onToggle={() => void voice.toggle()}
          onClearError={voice.clearError}
        />

        <TrialKeyPrompt
          open={trialKeyPrompt}
          exhausted={trialExhausted}
          remainingUsd={trialStatus?.remainingUsd ?? 0}
          budgetUsd={trialStatus?.budgetUsd ?? 0}
          onClose={closeTrialKeyPrompt}
        />

        {lookCapture && (
          <RegionSelectOverlay
            capture={lookCapture}
            adjustBeforeSend={phone}
            onComplete={finishLook}
          />
        )}

        {newPaper.open && (
          <NewPaperDialog
            key={newPaper.nonce}
            initialTitle={newPaper.title}
            onClose={() => dispatchUiNavigation({ type: "close-new-paper" })}
            onCreated={(created) => {
              dispatchUiNavigation({ type: "paper-created", projectKey: created.key });
              bump();
            }}
          />
        )}
        {voice.audioBlocked && (
          <div className="sound-unlock-hint" role="status">
            <span className="sound-unlock-dot" aria-hidden />
            Tap anywhere for sound
          </div>
        )}
      </div>
    </div>
  );

  // The shell only mounts once the boot screen starts dissolving, so children never
  // fire requests at a sandbox that is still waking. Keeping BootScreen at a stable
  // position in the tree lets it fade without remounting (and restarting) its spinner.
  return (
    <>
      {bootPhase === "booting" ? null : shell}
      {bootPhase === "done" ? null : backend === "locked" ? (
        isSignedIn && requiresModelConsent && consentLoaded && !consentAccepted ? (
          <ModelConsentScreen
            busy={consentBusy}
            error={consentError}
            onAccept={acceptConsent}
            onSignOut={() => void signOut({ redirectUrl: "/" })}
          />
        ) : (
          <LoginScreen />
        )
      ) : (
        <BootScreen
          state={backend === "ready" ? "loading" : backend}
          wakePhase={wakePhase}
          error={backendError}
          onRetry={retryBoot}
          leaving={bootPhase === "fading"}
        />
      )}
    </>
  );
}
