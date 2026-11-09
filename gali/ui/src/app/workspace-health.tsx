import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  describeSandboxFailure,
  sandboxProviderName,
} from "../../../shared/sandbox-health";
import { usePlatform } from "../platform/context";
import { WorkspaceUnavailableError, type WorkspaceHealth } from "../workspace-health";

// Outside the provider there is no sandbox to lose, as in isolated component trees.
const WorkspaceHealthContext = createContext<WorkspaceHealth>({ state: "ok" });

export function WorkspaceHealthProvider({ children }: { children: ReactNode }) {
  const { workspace } = usePlatform();
  const health = useSyncExternalStore(workspace.subscribe, workspace.current);
  return <WorkspaceHealthContext.Provider value={health}>{children}</WorkspaceHealthContext.Provider>;
}

export function useWorkspaceHealth(): WorkspaceHealth {
  return useContext(WorkspaceHealthContext);
}

export function WorkspaceHealthBanner({ onRecovered }: { onRecovered: () => void }) {
  const platform = usePlatform();
  const health = useWorkspaceHealth();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  if (health.state !== "unavailable") return null;
  const { failure } = health;

  const retry = () => {
    setRetrying(true);
    setRetryError(null);
    platform.boot.ensureReady()
      .then(onRecovered)
      .catch((error: unknown) => {
        // A typed failure re-renders this banner with the new reason by itself.
        if (error instanceof WorkspaceUnavailableError) return;
        setRetryError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => setRetrying(false));
  };

  return (
    <div className="workspace-health-banner" role="alert">
      <span className="workspace-health-dot" aria-hidden="true" />
      <div className="workspace-health-text">
        <p className="workspace-health-title">{describeSandboxFailure(failure)}</p>
        <p className="workspace-health-detail">
          {retryError ?? `${sandboxProviderName(failure.provider)}: ${failure.detail}`}
        </p>
      </div>
      <button type="button" onClick={retry} disabled={retrying}>
        {retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  );
}
