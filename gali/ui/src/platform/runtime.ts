import type { WakeProgressPhase } from "../../../shared/sandbox-health";
import { reportClientError } from "../account";
import {
  AuthRequiredError,
  createGaliClient,
  ensureSandboxReady,
  GALI_HTTP_BASE,
  httpBridgeEnabled,
  type GaliClient,
} from "../http-bridge";
import {
  createWorkspaceHealthMonitor,
  type WorkspaceHealthMonitor,
  type WorkspaceHealthView,
} from "../workspace-health";

export type PlatformMode = "hosted" | "none";

export type PlatformCapabilities = {
  sandboxWake: boolean;
  trialMetering: boolean;
  downloadFiles: boolean;
  voiceMemory: "hosted" | "none";
};

export type Platform = {
  mode: PlatformMode;
  client: GaliClient | null;
  capabilities: PlatformCapabilities;
  boot: {
    ensureReady(onProgress?: (phase: WakeProgressPhase) => void): Promise<{ status: string }>;
    isAuthRequired(error: unknown): boolean;
  };
  /** Whether the hosted sandbox is reachable. Always ok where there is no sandbox. */
  workspace: WorkspaceHealthView;
  /** Hosted errors go to the Vercel logs; elsewhere there is only the console. */
  reportError(errorCode: string, error: Error): Promise<void>;
};

export function createPlatform(
  mode: PlatformMode,
  client: GaliClient | null,
  health: WorkspaceHealthMonitor,
): Platform {
  if (mode === "hosted" && !client) throw new Error("hosted platform client is unavailable");
  const hosted = mode === "hosted";
  return Object.freeze({
    mode,
    client,
    capabilities: Object.freeze({
      sandboxWake: hosted,
      trialMetering: hosted,
      downloadFiles: hosted,
      voiceMemory: hosted ? "hosted" as const : "none" as const,
    }),
    boot: Object.freeze({
      ensureReady: hosted
        ? (onProgress?: (phase: WakeProgressPhase) => void) => ensureSandboxReady(health, onProgress)
        : async () => ({ status: "ready" }),
      isAuthRequired: (error: unknown) => error instanceof AuthRequiredError,
    }),
    workspace: Object.freeze({ current: health.current, subscribe: health.subscribe }),
    reportError: hosted
      ? reportClientError
      : async (errorCode: string, error: Error) => console.error(errorCode, error),
  });
}

let activePlatform: Platform | null = null;

export function bootPlatform(): Platform {
  const health = createWorkspaceHealthMonitor();
  const hosted = httpBridgeEnabled();
  const client = hosted ? createGaliClient({ baseUrl: GALI_HTTP_BASE, health }) : null;
  activePlatform = createPlatform(hosted ? "hosted" : "none", client, health);
  return activePlatform;
}

export function getPlatform(): Platform {
  if (!activePlatform) throw new Error("platform has not been initialized");
  return activePlatform;
}