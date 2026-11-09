import { useCallback, useEffect, useRef } from "react";
import type { ProjectDto } from "../api";
import type { ShellPage } from "../navigation";
import { usePlatform } from "../platform/context";
import { pushHostedVoiceMemory } from "../voice-memory";

export function useUiLocationSync(input: {
  project: ProjectDto | undefined;
  shellPage: ShellPage;
  workspaceView: { key: string; view: string } | null;
  connected: boolean;
  injectContext: (text: string) => boolean;
}) {
  const platform = usePlatform();
  const uiLocation = !input.project
    ? input.shellPage === "account"
      ? "on the Account page"
      : "on the Home screen, looking at the list of projects"
    : input.workspaceView?.key === input.project.key
      ? input.workspaceView.view
      : `in project "${input.project.title}"`;
  const lastInjectedLocationRef = useRef<string | null>(null);
  const uiLocationRef = useRef(uiLocation);
  uiLocationRef.current = uiLocation;

  const inject = useCallback((location: string) => {
    if (lastInjectedLocationRef.current === location) return;
    const sent = input.injectContext(
      `The user has navigated the app themselves. They are now ${location}. Silent context update — do not respond to it or mention it; use it to resolve what "this paper", "this PDF", "this page", or "this file" refer to.`,
    );
    if (!sent) return;
    lastInjectedLocationRef.current = location;
    if (platform.capabilities.voiceMemory === "hosted") {
      void pushHostedVoiceMemory({ uiLocation: location }).catch(() => {});
    }
  }, [input.injectContext, platform.capabilities.voiceMemory]);

  useEffect(() => {
    if (!input.connected) {
      lastInjectedLocationRef.current = null;
      return;
    }
    const timer = window.setTimeout(() => inject(uiLocation), 800);
    return () => window.clearTimeout(timer);
  }, [input.connected, inject, uiLocation]);

  return useCallback(() => inject(uiLocationRef.current), [inject]);
}
