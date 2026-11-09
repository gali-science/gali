import { describe, expect, test } from "vitest";
import type { NavEvent } from "../api";
import { createInitialNavigationState, navigationReducer } from "./reducer";
import type { NavigationState, UiNavigationAction } from "./types";

function ui(state: NavigationState, action: UiNavigationAction): NavigationState {
  return navigationReducer(state, { source: "ui", action });
}

function voice(
  state: NavigationState,
  event: NavEvent,
  context: { phone?: boolean; lookOpen?: boolean } = {},
): NavigationState {
  return navigationReducer(state, {
    source: "voice",
    event,
    context: {
      phone: context.phone ?? true,
      lookOpen: context.lookOpen ?? false,
    },
  });
}

describe("navigationReducer", () => {
  test("opening a project selects it with a show-overview command", () => {
    const state = ui(createInitialNavigationState(), { type: "open-project", projectKey: "alpha" });
    expect(state.selectedProjectKey).toBe("alpha");
    expect(state.workspaceCommand).toEqual({ id: 1, projectKey: "alpha", type: "show-overview" });
  });

  test("repeated voice commands get monotonic ids", () => {
    const first = voice(createInitialNavigationState(), { type: "open_paper", projectKey: "alpha", page: 3 });
    const second = voice(first, { type: "open_paper", projectKey: "alpha", page: 3 });
    expect(first.workspaceCommand).toEqual({ id: 1, projectKey: "alpha", type: "open-paper", page: 3 });
    expect(second.workspaceCommand?.id).toBe(2);
  });

  test("open_code_file selects the project and closes the phone transcript", () => {
    const open = ui(createInitialNavigationState(), { type: "open-chat" });
    const state = voice(open, { type: "open_code_file", projectKey: "alpha", path: "code/train.py" });
    expect(state.selectedProjectKey).toBe("alpha");
    expect(state.chatOpen).toBe(false);
    expect(state.workspaceCommand).toMatchObject({ type: "open-code-file", path: "code/train.py" });
  });

  test("set_viewer_page carries page or direction", () => {
    const byPage = voice(createInitialNavigationState(), { type: "set_viewer_page", projectKey: "alpha", page: 7 });
    expect(byPage.workspaceCommand).toMatchObject({ type: "set-viewer-page", page: 7, direction: null });
    const byDirection = voice(byPage, { type: "set_viewer_page", projectKey: "alpha", direction: "prev" });
    expect(byDirection.workspaceCommand).toMatchObject({ type: "set-viewer-page", page: null, direction: "prev" });
  });

  test("show_tab forwards the tab", () => {
    const state = voice(createInitialNavigationState(), { type: "show_tab", projectKey: "alpha", tab: "notes" });
    expect(state.workspaceCommand).toMatchObject({ type: "show-tab", tab: "notes" });
  });

  test("the chat is a tab on desktop and the sheet on phone", () => {
    const open = ui(createInitialNavigationState(), { type: "open-project", projectKey: "alpha" });
    const desktop = voice(open, { type: "show_tab", projectKey: "alpha", tab: "chat" }, { phone: false });
    expect(desktop.workspaceCommand).toMatchObject({ type: "show-tab", tab: "chat" });
    expect(desktop.chatOpen).toBe(false);
    const transcript = voice(open, { type: "open_transcript" }, { phone: false });
    expect(transcript.workspaceCommand).toMatchObject({ type: "show-tab", tab: "chat" });
    const phone = voice(open, { type: "show_tab", projectKey: "alpha", tab: "chat" });
    expect(phone.chatOpen).toBe(true);
    expect(phone.workspaceCommand).toBe(open.workspaceCommand);
  });

  test("switching projects drops the previous project's command", () => {
    const alpha = voice(createInitialNavigationState(), { type: "open_paper", projectKey: "alpha" });
    const home = voice(alpha, { type: "open_home" });
    expect(home.selectedProjectKey).toBeNull();
    expect(home.workspaceCommand).toBeNull();
  });

  test("the new paper dialog opens with a title and closes on create", () => {
    const opened = voice(createInitialNavigationState(), { type: "open_new_project", title: "Attention" });
    expect(opened.newPaper).toEqual({ open: true, title: "Attention", nonce: 1 });
    const created = ui(opened, { type: "paper-created", projectKey: "attention" });
    expect(created.newPaper.open).toBe(false);
    expect(created.selectedProjectKey).toBe("attention");
  });

  test("deleting the open project goes home; deleting another does nothing", () => {
    const open = ui(createInitialNavigationState(), { type: "open-project", projectKey: "alpha" });
    expect(ui(open, { type: "project-deleted", projectKey: "beta" })).toBe(open);
    const gone = ui(open, { type: "project-deleted", projectKey: "alpha" });
    expect(gone.selectedProjectKey).toBeNull();
    expect(gone.shellPage).toBe("home");
  });

  test("phone back closes the transcript, then the dialog, then Look, then goes into the workspace", () => {
    let state = ui(createInitialNavigationState(), { type: "open-project", projectKey: "alpha" });
    state = ui(state, { type: "open-chat" });
    state = ui(state, { type: "open-new-paper" });
    state = voice(state, { type: "navigate_back" });
    expect(state.chatOpen).toBe(false);
    state = voice(state, { type: "navigate_back" });
    expect(state.newPaper.open).toBe(false);
    state = voice(state, { type: "navigate_back" }, { lookOpen: true });
    expect(state.shellCommand).toMatchObject({ type: "cancel-look" });
    state = voice(state, { type: "navigate_back" });
    expect(state.workspaceCommand).toMatchObject({ type: "navigate-back", projectKey: "alpha" });
  });

  test("phone-only controls are ignored on desktop", () => {
    const start = createInitialNavigationState();
    expect(voice(start, { type: "open_transcript" }, { phone: false })).toBe(start);
    expect(voice(start, { type: "end_voice" }, { phone: false })).toBe(start);
    expect(voice(start, { type: "set_mic_muted", muted: true }, { phone: false })).toBe(start);
    expect(voice(start, { type: "end_voice" }).shellCommand).toMatchObject({ type: "end-voice" });
  });

  test("downloads do not navigate", () => {
    const start = createInitialNavigationState();
    expect(voice(start, { type: "download_pdf_annotations", projectKey: "alpha", format: "markdown" })).toBe(start);
  });

  test("a highlight's page turn survives the notes refresh sent with it", () => {
    const opened = voice(createInitialNavigationState(), { type: "open_paper", projectKey: "alpha", page: 7 });
    const refreshed = voice(opened, { type: "pdf_annotations_changed", projectKey: "alpha" });
    expect(refreshed).toBe(opened);
    expect(refreshed.workspaceCommand).toEqual({ id: 1, projectKey: "alpha", type: "open-paper", page: 7 });
  });
});
