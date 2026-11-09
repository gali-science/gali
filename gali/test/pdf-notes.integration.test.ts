import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { UserError } from "../src/lib/user-error.js";
import { createPdfAnnotations } from "../src/services/projects/pdf-annotations.js";
import { syncPdfShadows } from "../src/services/projects/pdf-cache.js";
import { withPdfDocument } from "../src/services/projects/pdfium.js";
import { dispatchVoiceTool } from "../src/voice/tools/dispatch.js";
import { createTestApp, CTC_DRO_PDF, uploadProject } from "./support/test-app.js";
import { createTestWorkspace, type TestWorkspace } from "./test.config.js";

const PAPER = "paper/ctc-dro.pdf";
let PROJECT = "";

let workspace: TestWorkspace;
let testApp: Awaited<ReturnType<typeof createTestApp>>;

function call(name: string, args: Record<string, unknown>) {
  return dispatchVoiceTool(testApp.registry, name, { projectKey: PROJECT, ...args }, "pdf-notes");
}

beforeAll(async () => {
  workspace = createTestWorkspace("pdf-notes");
  testApp = await createTestApp(workspace);
  PROJECT = (await uploadProject(testApp.app, workspace, { title: "PDF Notes" })).key;
});

afterAll(async () => {
  await testApp.close();
  workspace.cleanup();
});

test("highlight_pdf_text finds a passage across a line break and opens the viewer on it", async () => {
  testApp.navEvents.length = 0;
  const result = await call("highlight_pdf_text", {
    text: "CTC-DRO consistently outperforms group DRO and CTC-based baseline models",
    color: "green",
  });

  expect(result).toMatchObject({ highlighted: true, number: 1, page: 1, kind: "highlight", color: "green" });
  expect(testApp.navEvents).toEqual([
    { type: "open_paper", projectKey: PROJECT, page: 1 },
    { type: "pdf_annotations_changed", projectKey: PROJECT },
  ]);
  const [stored] = await testApp.app.pdfAnnotations.list(PROJECT, PAPER);
  expect(stored!.rects).toHaveLength(2);
  expect(stored!.pageWidth).toBe(612);
});

test("a quote that is not in the PDF fails and records nothing", async () => {
  testApp.navEvents.length = 0;
  await expect(call("highlight_pdf_text", { text: "this sentence is not in the paper" }))
    .rejects.toThrow(/quote not found in paper\/ctc-dro\.pdf/);
  expect(testApp.navEvents).toEqual([]);
  expect(await testApp.app.pdfAnnotations.list(PROJECT, PAPER)).toHaveLength(1);
});

test("a page past the end of the PDF, like a printed page number, opens nothing and says so", async () => {
  testApp.navEvents.length = 0;
  await expect(call("open_paper", { page: 3736 })).rejects.toThrow(/the PDF has \d+ pages/);
  await expect(call("set_viewer_page", { page: 3736 })).rejects.toThrow(/the PDF has \d+ pages/);
  expect(testApp.navEvents).toEqual([]);
  await expect(call("open_paper", { page: 2 })).resolves.toMatchObject({ opened: true, page: 2 });
  expect(testApp.navEvents).toEqual([{ type: "open_paper", projectKey: PROJECT, page: 2 }]);
});

test("the paper gets a hidden text shadow that project_source reads and searches", async () => {
  const folder = testApp.app.projects.dir(PROJECT);
  await syncPdfShadows(path.join(workspace.dataDir, "pdf-cache"), folder);
  expect(fs.readFileSync(path.join(folder, `${PAPER}.txt`), "utf8")).toMatch(/^Page images for this PDF: .*\n\n=== page 1 ===/);

  const tree = await call("project_source", { action: "tree", path: "paper" }) as { entries: Array<{ path: string }> };
  expect(tree.entries.map((entry) => entry.path)).toEqual([PAPER]);

  const read = await call("project_source", { action: "read", path: PAPER }) as { file: { path: string }; content: string };
  expect(read.file.path).toBe(`${PAPER}.txt`);
  expect(read.content).toContain("=== page 1 ===");

  const found = await call("project_source", { action: "search", query: "consistently outperforms group dro" }) as {
    results: Array<{ path: string; page?: number; text: string }>;
  };
  expect(found.results[0]).toMatchObject({ path: `${PAPER}.txt`, page: 1 });
  expect(found.results[0]!.text).toContain("consistently outperforms group DRO");
});

test("an ambiguous quote says so, and elided quotes match start to end", async () => {
  const ambiguous = await call("highlight_pdf_text", { text: "group DRO" });
  expect(ambiguous).toMatchObject({ number: 2, page: 1 });
  expect((ambiguous as { ambiguous?: string }).ambiguous).toMatch(/occurs \d+ times/);

  const elided = await call("add_pdf_note", {
    quote: "We present CTC-DRO … consistently high-loss groups",
    text: "Core idea: smooth the group weights.",
  });
  expect(elided).toMatchObject({ noted: true, number: 3, kind: "highlight", note: "Core idea: smooth the group weights." });
});

test("notes attach to a highlight by number or to a whole page", async () => {
  await expect(call("add_pdf_note", { number: 1, text: "Check Table 2 for this." }))
    .resolves.toMatchObject({ number: 1, note: "Check Table 2 for this." });
  await expect(call("add_pdf_note", { page: 4, text: "Method starts here." }))
    .resolves.toMatchObject({ number: 4, page: 4, kind: "page note" });
  await expect(call("add_pdf_note", { page: 400, text: "nowhere" })).rejects.toThrow(/out of range/);
  await expect(call("add_pdf_note", { text: "unanchored" })).rejects.toThrow(/not open on screen/);
});

test("list, go to, and remove work by number and survive a fresh store", async () => {
  const listed = await call("list_pdf_notes", {}) as { count: number; annotations: Array<{ number: number; page: number }> };
  expect(listed.count).toBe(4);
  expect(listed.annotations.map((item) => item.page)).toEqual([1, 1, 1, 4]);

  testApp.navEvents.length = 0;
  await expect(call("go_to_pdf_note", { number: 4 })).resolves.toMatchObject({ opened: true, page: 4 });
  expect(testApp.navEvents).toEqual([{ type: "open_paper", projectKey: PROJECT, page: 4 }]);

  await expect(call("remove_pdf_note", { number: 2 })).resolves.toMatchObject({ removed: true, number: 2 });
  await expect(call("go_to_pdf_note", { number: 2 })).rejects.toThrow("no annotation 2 on paper/ctc-dro.pdf; existing: 1, 3, 4");

  const reopened = createPdfAnnotations({ dataDir: workspace.dataDir, readPdf: async () => new Uint8Array() });
  expect((await reopened.list(PROJECT, PAPER)).map((item) => item.number)).toEqual([3, 1, 4]);
  await expect(call("highlight_pdf_text", { text: "mitigate CTC's scaling issues" }))
    .resolves.toMatchObject({ number: 5 });
});

test("the download tools start a download only when there is something to export", async () => {
  testApp.navEvents.length = 0;
  const empty = await uploadProject(testApp.app, workspace, { title: "No Notes Yet" });
  for (const tool of ["download_annotated_pdf", "download_pdf_notes"]) {
    await expect(call(tool, { projectKey: empty.key }))
      .rejects.toThrow("the PDF has no highlights or notes to export");
  }
  expect(testApp.navEvents).toEqual([]);

  await expect(call("download_annotated_pdf", {})).resolves.toMatchObject({ started: true, count: 4 });
  await expect(call("download_pdf_notes", {})).resolves.toMatchObject({ started: true, count: 4 });
  expect(testApp.navEvents).toEqual([
    { type: "download_pdf_annotations", projectKey: PROJECT, format: "pdf" },
    { type: "download_pdf_annotations", projectKey: PROJECT, format: "markdown" },
  ]);
});

test("the notes export is markdown by page, numbered like the pins", async () => {
  const exported = await testApp.app.pdfAnnotations.export(PROJECT, PAPER, "markdown");
  expect(exported.filename).toBe("ctc-dro-notes.md");
  expect(exported.contentType).toBe("text/markdown; charset=utf-8");
  expect(new TextDecoder().decode(exported.data)).toBe([
    "# Notes on ctc-dro.pdf",
    "",
    "## Page 1",
    "",
    "### 3 · Highlight",
    "",
    "> We present CTC-DRO … consistently high-loss groups",
    "",
    "**Note:** Core idea: smooth the group weights.",
    "",
    "### 5 · Highlight",
    "",
    "> mitigate CTC's scaling issues",
    "",
    "### 1 · Highlight",
    "",
    "> CTC-DRO consistently outperforms group DRO and CTC-based baseline models",
    "",
    "**Note:** Check Table 2 for this.",
    "",
    "## Page 4",
    "",
    "### 4 · Note",
    "",
    "Method starts here.",
    "",
  ].join("\n"));
});

test("a quote's layout line breaks collapse; a note keeps the user's own", async () => {
  const other = await uploadProject(testApp.app, workspace, { title: "Multiline", pdfName: "multiline.pdf" });
  await call("highlight_pdf_text", { projectKey: other.key, text: "Modern deep learning models\noften achieve", note: "First line.\nSecond line." });
  await call("add_pdf_note", { projectKey: other.key, page: 2, text: "Page two:\n- a dash list\n- inside the note" });

  const markdown = new TextDecoder().decode((await testApp.app.pdfAnnotations.export(other.key, other.paperPath!, "markdown")).data);
  expect(markdown).toBe([
    "# Notes on multiline.pdf",
    "",
    "## Page 1",
    "",
    "### 1 · Highlight",
    "",
    "> Modern deep learning models often achieve",
    "",
    "**Note:** First line.",
    "Second line.",
    "",
    "## Page 2",
    "",
    "### 2 · Note",
    "",
    "Page two:",
    "- a dash list",
    "- inside the note",
    "",
  ].join("\n"));
});

test("add_finding_to_notes keeps a finding like its Add to notes button: once, orange, on its quote", async () => {
  const project = await uploadProject(testApp.app, workspace, { title: "Finding Notes" });
  fs.writeFileSync(path.join(testApp.app.projects.dir(project.key), "review.json"), JSON.stringify({
    title: "Review",
    findings: [
      {
        id: "f1",
        severity: "serious",
        title: "Baseline gap",
        body: "The claim needs Table 2.",
        refs: [
          { code: { path: "code/train.py", lines: [1, 1] } },
          { paper: { page: 1, quote: "CTC-DRO consistently outperforms group DRO and CTC-based baseline models" } },
        ],
        visuals: [],
      },
      { id: "f2", severity: "minor", title: "Default differs", body: "train.py uses 0.1.", refs: [{ code: { path: "code/train.py", lines: [1, 1] } }], visuals: [] },
    ],
  }));
  testApp.navEvents.length = 0;

  await expect(call("add_finding_to_notes", { projectKey: project.key, findingId: "f1" })).resolves.toMatchObject({
    noted: true, number: 1, page: 1, kind: "highlight", note: "Baseline gap. The claim needs Table 2.", color: "orange",
  });
  await expect(call("add_finding_to_notes", { projectKey: project.key, findingId: "f1" })).resolves.toMatchObject({ number: 1 });
  await expect(call("add_finding_to_notes", { projectKey: project.key, findingId: "f2", page: 3 })).resolves.toMatchObject({
    number: 2, page: 3, kind: "page note", note: "Default differs. train.py uses 0.1.",
  });
  const missing = call("add_finding_to_notes", { projectKey: project.key, findingId: "f9" });
  await expect(missing).rejects.toThrow("no finding f9 in the review");
  await expect(missing).rejects.toBeInstanceOf(UserError);

  const stored = await testApp.app.pdfAnnotations.list(project.key, project.paperPath!);
  expect(stored.map((item) => [item.number, item.findingId, item.color])).toEqual([[1, "f1", "orange"], [2, "f2", "yellow"]]);
  expect(testApp.navEvents).toEqual([
    { type: "open_paper", projectKey: project.key, page: 1 },
    { type: "pdf_annotations_changed", projectKey: project.key },
    { type: "open_paper", projectKey: project.key, page: 3 },
    { type: "pdf_annotations_changed", projectKey: project.key },
  ]);
});

test("the PDF export is the PDF with standard Highlight and Text annotations written in", async () => {
  const { data, filename, contentType } = await testApp.app.pdfAnnotations.export(PROJECT, PAPER, "pdf");
  expect(filename).toBe("ctc-dro-annotated.pdf");
  expect(contentType).toBe("application/pdf");
  expect(new TextDecoder().decode(data.subarray(0, 5))).toBe("%PDF-");

  const source = fs.readFileSync(CTC_DRO_PDF);
  const ours = (bytes: Uint8Array, number: number) => withPdfDocument(bytes, (doc) =>
    doc.page(number, (page) => page.annotations().filter((annotation) => annotation.kind !== "link"))
  );
  expect(await ours(data, 1)).toEqual([
    { kind: "highlight", contents: "1. Check Table 2 for this." },
    { kind: "highlight", contents: "3. Core idea: smooth the group weights." },
    { kind: "highlight", contents: "5." },
  ]);
  expect(await ours(data, 4)).toEqual([{ kind: "note", contents: "4. Method starts here." }]);
  expect(await withPdfDocument(data, (doc) => doc.page(1, (page) => page.annotations().length)))
    .toBe(await withPdfDocument(source, (doc) => doc.page(1, (page) => page.annotations().length)) + 3);
});
