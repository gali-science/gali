import type { NavEvent } from "../api";
import type { ProjectTab } from "../../../shared/domain/contracts";

export type ShellPage = "home" | "account";

export type WorkspaceNavigationRequest =
  | { type: "show-overview" }
  | { type: "open-paper"; page?: number }
  | { type: "open-code-file"; path: string; lines?: [number, number] }
  | { type: "set-viewer-page"; page: number | null; direction: "next" | "prev" | null }
  | { type: "show-tab"; tab: ProjectTab }
  | { type: "open-project-actions" }
  | { type: "close-project-actions" }
  | { type: "navigate-back" };

export type WorkspaceNavigationCommand = WorkspaceNavigationRequest & {
  id: number;
  projectKey: string;
};

export type ShellNavigationRequest =
  | { type: "cancel-look" }
  | { type: "set-mic-muted"; muted: boolean }
  | { type: "end-voice" };

export type ShellNavigationCommand = ShellNavigationRequest & { id: number };

export type NewPaperDialogState = {
  open: boolean;
  title: string;
  nonce: number;
};

export type NavigationState = {
  selectedProjectKey: string | null;
  shellPage: ShellPage;
  chatOpen: boolean;
  newPaper: NewPaperDialogState;
  workspaceCommand: WorkspaceNavigationCommand | null;
  shellCommand: ShellNavigationCommand | null;
  nextCommandId: number;
};

export type UiNavigationAction =
  | { type: "open-home" }
  | { type: "open-shell-page"; page: ShellPage }
  | { type: "open-project"; projectKey: string }
  | { type: "project-deleted"; projectKey: string }
  | { type: "open-chat" }
  | { type: "close-chat" }
  | { type: "toggle-chat" }
  | { type: "open-new-paper"; title?: string }
  | { type: "close-new-paper" }
  | { type: "paper-created"; projectKey: string }
  | {
      type: "workspace";
      projectKey: string;
      command: WorkspaceNavigationRequest;
    };

export type NavigationAction =
  | { source: "ui"; action: UiNavigationAction }
  | {
      source: "voice";
      event: NavEvent;
      context: {
        phone: boolean;
        lookOpen: boolean;
      };
    };
