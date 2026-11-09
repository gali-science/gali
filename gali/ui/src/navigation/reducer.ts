import type {
  NavigationAction,
  NavigationState,
  ShellNavigationCommand,
  ShellNavigationRequest,
  UiNavigationAction,
  WorkspaceNavigationCommand,
  WorkspaceNavigationRequest,
} from "./types";

export function createInitialNavigationState(): NavigationState {
  return {
    selectedProjectKey: null,
    shellPage: "home",
    chatOpen: false,
    newPaper: { open: false, title: "", nonce: 0 },
    workspaceCommand: null,
    shellCommand: null,
    nextCommandId: 0,
  };
}

function selectProject(state: NavigationState, projectKey: string | null): NavigationState {
  return {
    ...state,
    selectedProjectKey: projectKey,
    workspaceCommand:
      projectKey !== null && state.selectedProjectKey === projectKey
        ? state.workspaceCommand
        : null,
  };
}

function issueWorkspaceCommand(
  state: NavigationState,
  projectKey: string,
  request: WorkspaceNavigationRequest,
): NavigationState {
  const id = state.nextCommandId + 1;
  return {
    ...selectProject(state, projectKey),
    shellPage: "home",
    workspaceCommand: {
      ...request,
      id,
      projectKey,
    } as WorkspaceNavigationCommand,
    nextCommandId: id,
  };
}

function issueShellCommand(
  state: NavigationState,
  command: ShellNavigationRequest,
): NavigationState {
  const id = state.nextCommandId + 1;
  return {
    ...state,
    shellCommand: { ...command, id } as ShellNavigationCommand,
    nextCommandId: id,
  };
}

function openNewPaper(state: NavigationState, title?: string): NavigationState {
  return {
    ...state,
    newPaper: { open: true, title: title ?? "", nonce: state.newPaper.nonce + 1 },
  };
}

function closeNewPaper(state: NavigationState): NavigationState {
  return { ...state, newPaper: { ...state.newPaper, open: false } };
}

function reduceUiNavigation(
  state: NavigationState,
  action: UiNavigationAction,
): NavigationState {
  switch (action.type) {
    case "open-home":
      return { ...selectProject(state, null), shellPage: "home" };
    case "open-shell-page":
      return { ...selectProject(state, null), shellPage: action.page };
    case "open-project":
      return issueWorkspaceCommand(state, action.projectKey, { type: "show-overview" });
    case "project-deleted":
      if (state.selectedProjectKey !== action.projectKey) return state;
      return { ...selectProject(state, null), shellPage: "home" };
    case "open-chat":
      return { ...state, chatOpen: true };
    case "close-chat":
      return { ...state, chatOpen: false };
    case "toggle-chat":
      return { ...state, chatOpen: !state.chatOpen };
    case "open-new-paper":
      return openNewPaper(state, action.title);
    case "close-new-paper":
      return closeNewPaper(state);
    case "paper-created":
      return closeNewPaper(
        issueWorkspaceCommand(state, action.projectKey, { type: "show-overview" }),
      );
    case "workspace":
      return issueWorkspaceCommand(state, action.projectKey, action.command);
  }
}

function reduceVoiceNavigation(
  state: NavigationState,
  action: Extract<NavigationAction, { source: "voice" }>,
): NavigationState {
  const { event, context } = action;
  const closeChatOnPhone = (next: NavigationState) =>
    context.phone ? { ...next, chatOpen: false } : next;
  switch (event.type) {
    case "open_home":
      return { ...selectProject(state, null), shellPage: "home" };
    case "open_project":
      return issueWorkspaceCommand(state, event.projectKey, { type: "show-overview" });
    case "open_paper":
      return closeChatOnPhone(issueWorkspaceCommand(state, event.projectKey, {
        type: "open-paper",
        ...(event.page === undefined ? {} : { page: event.page }),
      }));
    case "open_code_file":
      return closeChatOnPhone(issueWorkspaceCommand(state, event.projectKey, {
        type: "open-code-file",
        path: event.path,
        ...(event.lines === undefined ? {} : { lines: event.lines }),
      }));
    case "set_viewer_page":
      return issueWorkspaceCommand(state, event.projectKey, {
        type: "set-viewer-page",
        page: event.page ?? null,
        direction: event.direction ?? null,
      });
    case "show_tab":
      if (event.tab === "chat" && context.phone) return { ...state, chatOpen: true };
      return issueWorkspaceCommand(state, event.projectKey, { type: "show-tab", tab: event.tab });
    case "pdf_annotations_changed":
      // The open workspace refetches its notes from the nav stream; a command here would replace the open_paper sent with it.
      return state;
    case "download_pdf_annotations":
      // Handled by the navigation effects (browser download); no navigation change.
      return state;
    case "open_new_project":
      return openNewPaper(state, event.title);
    case "close_new_project":
      return closeNewPaper(state);
    case "open_transcript":
      if (context.phone) return { ...state, chatOpen: true };
      return state.selectedProjectKey
        ? issueWorkspaceCommand(state, state.selectedProjectKey, { type: "show-tab", tab: "chat" })
        : state;
    case "close_transcript":
      return context.phone ? { ...state, chatOpen: false } : state;
    case "set_mic_muted":
      return context.phone
        ? issueShellCommand(state, { type: "set-mic-muted", muted: event.muted })
        : state;
    case "end_voice":
      return context.phone ? issueShellCommand(state, { type: "end-voice" }) : state;
    case "navigate_back":
      if (!context.phone) return state;
      if (state.chatOpen) return { ...state, chatOpen: false };
      if (state.newPaper.open) return closeNewPaper(state);
      if (context.lookOpen) return issueShellCommand(state, { type: "cancel-look" });
      if (!state.selectedProjectKey) return state;
      return issueWorkspaceCommand(state, state.selectedProjectKey, { type: "navigate-back" });
    case "open_project_actions":
      return context.phone
        ? issueWorkspaceCommand(state, event.projectKey, { type: "open-project-actions" })
        : state;
    case "close_project_actions":
      return context.phone
        ? issueWorkspaceCommand(state, event.projectKey, { type: "close-project-actions" })
        : state;
  }
}

export function navigationReducer(
  state: NavigationState,
  action: NavigationAction,
): NavigationState {
  return action.source === "ui"
    ? reduceUiNavigation(state, action.action)
    : reduceVoiceNavigation(state, action);
}
