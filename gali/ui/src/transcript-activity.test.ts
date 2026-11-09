import { describe, expect, test } from "vitest";
import { formatTranscript, transcriptItems, type TranscriptItem } from "./transcript-activity";
import type { VoiceLine } from "./useVoice";

const titles = new Map([["attention", "Attention Is All You Need"]]);

function build(lines: Array<Record<string, unknown>>): TranscriptItem[] {
  return transcriptItems(lines.map((line, id) => ({ id, ...line })) as VoiceLine[], titles);
}

function labels(items: TranscriptItem[]): string[] {
  return items.map((item) => (item.kind === "activity" ? item.label : `${item.role}: ${item.text}`));
}

function tool(name: string, args: unknown, result: unknown) {
  return { kind: "tool", name, args, result };
}

describe("transcriptItems", () => {
  test("maps actions to readable rows and hides read-only checks", () => {
    const items = build([
      { kind: "message", role: "user", text: "open the attention paper" },
      tool("list_projects", {}, { projects: [] }),
      tool("project_source", { action: "tree" }, { entries: [] }),
      tool("open_project", { query: "attention" }, { opened: true, project: { key: "attention", title: "Attention Is All You Need" } }),
      tool("open_code_file", { path: "code/model.py" }, { opened: true, projectKey: "attention", path: "code/model.py" }),
      tool("ask_reviewer", { question: "Does the code match eq. 1?", summary: "Check eq. 1 against the code" }, { asked: true, queued: "runs next" }),
      tool("rename_project", { title: "Attention" }, { renamed: true, projectKey: "attention", title: "Attention" }),
      tool("delete_project", { confirmTitle: "Attention" }, { deleted: true }),
      tool("delete_project", {}, { deleted: true }),
      tool("open_code_file", { path: "missing.py" }, { error: "file not found: missing.py" }),
      { kind: "message", role: "assistant", text: "Done." },
    ]);
    expect(labels(items)).toEqual([
      "user: open the attention paper",
      "Opened Attention Is All You Need",
      "Opened model.py",
      "Asked Gali: Check eq. 1 against the code",
      "Renamed to Attention",
      "Deleted Attention",
      "Deleted",
      "assistant: Done.",
    ]);
    expect(items[3]).toMatchObject({ detail: "queued" });
  });

  test("page turns fold into the opened paper, and repeated turns collapse", () => {
    const items = build([
      tool("open_paper", {}, { opened: true, projectKey: "attention", path: "paper/attention.pdf" }),
      tool("set_viewer_page", { page: 8 }, { turned: true, page: 8 }),
      { kind: "message", role: "assistant", text: "Here is page 8." },
      tool("set_viewer_page", { direction: "next" }, { turned: true, direction: "next" }),
      tool("set_viewer_page", { page: 10 }, { turned: true, page: 10 }),
    ]);
    expect(labels(items)).toEqual([
      "Opened the PDF",
      "assistant: Here is page 8.",
      "Turned to page 10",
    ]);
    expect(items[0]).toMatchObject({ page: 8 });
  });

  test("quick answers read as look-ups, failures included", () => {
    const items = build([
      tool("quick_answer", { question: "What dataset?" }, { answer: "WMT 2014." }),
      tool("quick_answer", { question: "What optimizer?" }, { error: "timeout" }),
      tool("quick_answer", { question: "What is in the code?" }, { noPaper: true, note: "Call ask_reviewer." }),
    ]);
    expect(items).toEqual([
      { kind: "activity", id: 0, icon: "lookup", label: "Looked up: What dataset?", state: "done" },
      { kind: "activity", id: 1, icon: "lookup", label: "Lookup failed: What optimizer?", state: "failed" },
    ]);
  });

  test("reviewer start statuses are hidden; finish statuses show with the paper title", () => {
    const items = build([
      { kind: "status", text: "Working on attention", projectKey: "attention", mark: { type: "reviewer", phase: "started" } },
      { kind: "status", text: "Answer ready on attention", projectKey: "attention", mark: { type: "reviewer", phase: "finished" } },
      { kind: "status", text: "Shared view", mark: { type: "view-shared" } },
    ]);
    expect(labels(items)).toEqual(["Answer ready on Attention Is All You Need"]);
  });

  test("copy text keeps the conversation and activity labels without tool data", () => {
    const items = build([
      { kind: "message", role: "user", text: "check the claim" },
      tool("ask_reviewer", { question: "Is claim 1 supported?", summary: "Check claim 1" }, { asked: true }),
      { kind: "message", role: "assistant", text: "Asked." },
    ]);
    expect(formatTranscript(items)).toBe([
      "User: check the claim",
      "· Asked Gali: Check claim 1",
      "Gali: Asked.",
    ].join("\n"));
  });
});
