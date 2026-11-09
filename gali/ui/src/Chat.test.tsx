import { act, fireEvent, render } from "@testing-library/react";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { Chat, formatDebugTranscript } from "./Chat";
import { formatTranscript, transcriptItems } from "./transcript-activity";
import { setTranscriptDebug } from "./transcript-debug";
import type { VoiceLine } from "./useVoice";

beforeAll(() => {
  Element.prototype.scrollTo = (() => {}) as never;
});

beforeEach(() => {
  const values: Record<string, string> = {};
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values[key] ?? null,
      setItem: (key: string, value: string) => {
        values[key] = value;
      },
      removeItem: (key: string) => {
        delete values[key];
      },
    },
  });
});

const projects = [{ key: "review", title: "Paper Review" }];

const lines = [
  { id: 1, kind: "message", role: "user", text: "check the main claim" },
  { id: 2, kind: "tool", name: "list_projects", args: {}, result: { projects: [] } },
  { id: 3, kind: "tool", name: "ask_reviewer", args: { projectKey: "review", question: "Is claim 1 supported?", summary: "Check the main claim" }, result: { asked: true, projectKey: "review" } },
  { id: 4, kind: "status", text: "Working on review", projectKey: "review", mark: { type: "reviewer", phase: "started" } },
  { id: 5, kind: "status", text: "Answer ready on review", projectKey: "review", mark: { type: "reviewer", phase: "finished" } },
  { id: 6, kind: "message", role: "assistant", text: "Asked." },
] as VoiceLine[];

function renderChat(chatLines: VoiceLine[] = lines) {
  return render(
    <Chat open lines={chatLines} onClose={vi.fn()} sendText={vi.fn()} projects={projects} />,
  );
}

test("assistant bubbles render markdown, user bubbles stay literal", () => {
  const { container } = renderChat([
    { id: 1, kind: "message", role: "user", text: "try `beta`" },
    { id: 2, kind: "message", role: "assistant", text: "ran `beta`" },
  ] as VoiceLine[]);
  const user = container.querySelector(".bubble.u");
  const assistant = container.querySelector(".bubble.a");
  expect(user?.textContent).toBe("try `beta`");
  expect(user?.querySelector("code")).toBeNull();
  expect(assistant?.querySelector("code")?.textContent).toBe("beta");
});

test("by default the transcript shows activity rows, not tool calls", () => {
  const { container, getByText, queryByText } = renderChat();
  expect(container.querySelector(".thread.is-clean")).not.toBeNull();
  expect(container.querySelector(".tool")).toBeNull();
  expect(queryByText(/list_projects|ask_reviewer/)).toBeNull();
  expect(queryByText("Working on review")).toBeNull();
  const rows = [...container.querySelectorAll(".activity")].map((row) => row.textContent);
  expect(rows).toEqual(["Asked Gali: Check the main claim", "Answer ready on Paper Review"]);
  expect(getByText("Chat")).toBeTruthy();
});

test("debug mode shows every tool call and status line", () => {
  setTranscriptDebug(true);
  const { container, getByText } = renderChat();
  expect(container.querySelector(".thread.is-clean")).toBeNull();
  expect(container.querySelectorAll(".tool")).toHaveLength(2);
  expect(getByText("tool · ask_reviewer")).toBeTruthy();
  expect(getByText("Answer ready on review")).toBeTruthy();
  expect(container.querySelector(".activity")).toBeNull();
});

test("flipping the debug switch updates an open transcript", () => {
  const { container } = renderChat();
  expect(container.querySelector(".tool")).toBeNull();
  act(() => setTranscriptDebug(true));
  expect(container.querySelectorAll(".tool")).toHaveLength(2);
  act(() => setTranscriptDebug(false));
  expect(container.querySelector(".tool")).toBeNull();
});

test("Copy writes the clean transcript by default", () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  const { getByTitle } = renderChat();
  fireEvent.click(getByTitle("Copy chat"));
  const expected = formatTranscript(transcriptItems(lines, new Map([["review", "Paper Review"]])));
  expect(writeText).toHaveBeenCalledWith(expected);
  expect(expected).toBe([
    "User: check the main claim",
    "· Asked Gali: Check the main claim",
    "· Answer ready on Paper Review",
    "Gali: Asked.",
  ].join("\n"));
});

test("Copy writes the debug transcript including tools in debug mode", () => {
  setTranscriptDebug(true);
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.assign(navigator, { clipboard: { writeText } });
  expect(formatDebugTranscript(lines)).toContain("[tool: ask_reviewer]");
  const { getByTitle } = renderChat();
  fireEvent.click(getByTitle("Copy chat"));
  expect(writeText).toHaveBeenCalledWith(formatDebugTranscript(lines));
});

test("the Chat tab has no composer of its own; the drawer keeps one", () => {
  const embedded = render(
    <Chat open embedded lines={lines} onClose={vi.fn()} sendText={vi.fn()} projects={projects} />,
  );
  expect(embedded.container.querySelector(".comp")).toBeNull();
  embedded.unmount();
  const drawer = renderChat();
  expect(drawer.container.querySelector(".comp input")).not.toBeNull();
});

test("the drawer and the Chat tab both say Gali can make mistakes, right above the input", () => {
  const notice = "Gali can make mistakes. Verify before relying on it.";
  const embedded = render(
    <Chat open embedded lines={lines} onClose={vi.fn()} sendText={vi.fn()} projects={projects} />,
  );
  expect(embedded.getByText(notice)).toBeTruthy();
  embedded.unmount();
  const drawer = renderChat();
  expect(drawer.getByText(notice).nextElementSibling?.className).toBe("composer-tray");
});

test("a transcript of only hidden checks reads as empty in the clean view", () => {
  const hidden = [
    { id: 1, kind: "tool", name: "list_projects", args: {}, result: { projects: [] } },
  ] as VoiceLine[];
  const { container, getByTitle } = renderChat(hidden);
  expect(container.querySelector(".chat-empty")).not.toBeNull();
  expect((getByTitle("Copy chat") as HTMLButtonElement).disabled).toBe(true);
});
