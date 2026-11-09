import { useCallback, useEffect, useReducer, useRef } from "react";
import { onNavEvent, onProjectEvent } from "../api";
import { downloadPdfAnnotations } from "../downloads";
import {
  createInitialNavigationState,
  navigationReducer,
  type UiNavigationAction,
} from "../navigation";

type NavigationVoice = {
  connected: boolean;
  connecting: boolean;
  setMicMuted: (muted: boolean) => void;
  stop: () => Promise<void>;
};

export function useAppNavigation() {
  const [navigation, dispatchNavigation] = useReducer(
    navigationReducer,
    createInitialNavigationState(),
  );
  const dispatchUiNavigation = useCallback((action: UiNavigationAction) => {
    dispatchNavigation({ source: "ui", action });
  }, []);

  return {
    ...navigation,
    dispatchNavigation,
    dispatchUiNavigation,
  };
}

export function useAppNavigationEffects(input: {
  navigation: ReturnType<typeof useAppNavigation>;
  phone: boolean;
  lookOpen: boolean;
  finishLook: (result: { status: "cancelled" }) => void;
  voice: NavigationVoice;
  bump: () => void;
}): void {
  const { navigation, phone, lookOpen, finishLook, voice, bump } = input;
  const { dispatchNavigation, shellCommand } = navigation;
  const { connected, connecting, setMicMuted, stop } = voice;

  useEffect(() => onNavEvent((event) => {
    if (event.type === "download_pdf_annotations") {
      downloadPdfAnnotations(event.projectKey, event.format);
      return;
    }
    dispatchNavigation({ source: "voice", event, context: { phone, lookOpen } });
    if (event.type === "open_project" || event.type === "open_home") bump();
  }), [bump, dispatchNavigation, lookOpen, phone]);

  const consumedShellCommandId = useRef(0);
  useEffect(() => {
    const command = shellCommand;
    if (!command || command.id <= consumedShellCommandId.current) return;
    consumedShellCommandId.current = command.id;
    if (command.type === "cancel-look") {
      if (lookOpen) finishLook({ status: "cancelled" });
      return;
    }
    if (command.type === "set-mic-muted") {
      setMicMuted(command.muted);
      return;
    }
    if (connected || connecting) void stop();
  }, [connected, connecting, finishLook, lookOpen, setMicMuted, shellCommand, stop]);

  useEffect(() => onProjectEvent(() => bump()), [bump]);
}
