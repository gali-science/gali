import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { NotesPanel } from "./NotesPanel";

vi.mock("../../platform/runtime", () => ({ getPlatform: () => ({ capabilities: { downloadFiles: false } }) }));

afterEach(cleanup);

test("both notes views show an empty state when they have nothing", () => {
  render(
    <NotesPanel
      projectKey="alpha"
      annotations={[]}
      findings={[]}
      page={1}
      error=""
      focusNumber={null}
      onFocusHandled={vi.fn()}
      onGo={vi.fn()}
      onOpenFinding={vi.fn()}
      onSetNote={vi.fn(async () => {})}
      onDelete={vi.fn()}
      onAddPageNote={vi.fn(async () => {})}
    />,
  );
  expect(screen.getByText("No notes yet")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Saved findings" }));
  expect(screen.getByText("No saved findings yet")).toBeTruthy();
  expect(screen.queryByText("No notes yet")).toBeNull();
});

test("math in a saved finding is typeset, and editing shows the raw source", () => {
  Element.prototype.scrollIntoView = vi.fn();
  const note = "Work out L. Backward: $\\partial L/\\partial e = -2$.";
  render(
    <NotesPanel
      projectKey="alpha"
      annotations={[{ number: 1, page: 4, pageWidth: 612, pageHeight: 792, rects: [], quote: null, note, color: "orange", createdAt: "2026-10-30T00:00:00.000Z", findingId: "f1" }]}
      findings={[]}
      page={4}
      error=""
      focusNumber={null}
      onFocusHandled={vi.fn()}
      onGo={vi.fn()}
      onOpenFinding={vi.fn()}
      onSetNote={vi.fn(async () => {})}
      onDelete={vi.fn()}
      onAddPageNote={vi.fn(async () => {})}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Saved findings" }));
  const text = document.querySelector(".note-item-text") as HTMLElement;
  expect(text.querySelector(".katex")).toBeTruthy();
  expect(text.textContent).not.toContain("$");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect((document.querySelector(".note-item-input") as HTMLTextAreaElement).value).toBe(note);
});

test("a saved finding shows its visuals, and your own notes show none", () => {
  const base = { pageWidth: 612, pageHeight: 792, rects: [], quote: null, color: "orange" as const, createdAt: "2026-10-30T00:00:00.000Z" };
  render(
    <NotesPanel
      projectKey="alpha"
      annotations={[
        { ...base, number: 1, page: 4, note: "Group weights. See the steps.", findingId: "s1" },
        { ...base, number: 2, page: 4, note: "My own note" },
      ]}
      findings={[{
        id: "s1",
        severity: "study",
        title: "Group weights",
        body: "See the steps.",
        refs: [],
        visuals: [{ table: { caption: "Steps, computed by Gali", columns: ["step", "group 1"], rows: [["× 0.5", "0.553"]] } }],
      }]}
      page={4}
      error=""
      focusNumber={null}
      onFocusHandled={vi.fn()}
      onGo={vi.fn()}
      onOpenFinding={vi.fn()}
      onSetNote={vi.fn(async () => {})}
      onDelete={vi.fn()}
      onAddPageNote={vi.fn(async () => {})}
    />,
  );
  expect(screen.getByText("My own note")).toBeTruthy();
  expect(document.querySelector(".review-visual")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Saved findings" }));
  expect(screen.getByText("Steps, computed by Gali")).toBeTruthy();
  expect(screen.getByRole("cell", { name: "0.553" })).toBeTruthy();
});
