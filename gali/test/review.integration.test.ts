import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { MAX_CODE_ZIP_BYTES } from "../shared/domain/contracts.js";
import { shortTitle, titleFromPdfName } from "../shared/domain/project-title.js";
import { dispatchVoiceTool } from "../src/voice/tools/dispatch.js";
import { createFakeProvider, createTestApp, uploadProject, waitFor } from "./support/test-app.js";
import { createTestWorkspace, type TestWorkspace } from "./test.config.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function setup(provider = createFakeProvider()) {
  const workspace: TestWorkspace = createTestWorkspace("review");
  const testApp = await createTestApp(workspace, provider.provider);
  cleanups.push(async () => {
    await testApp.close();
    workspace.cleanup();
  });
  const call = (name: string, args: Record<string, unknown>) =>
    dispatchVoiceTool(testApp.registry, name, args, "review");
  return { workspace, testApp, call, turns: provider.turns, opens: provider.opens };
}

test("an upload becomes paper/ plus the unwrapped code/, with no excluded files", async () => {
  const { workspace, testApp } = await setup();
  const project = await uploadProject(testApp.app, workspace, {
    title: "CTC DRO",
    code: {
      "ctc-dro-main/train.py": "print('train')\n",
      "ctc-dro-main/.env": "OPENAI_API_KEY=nope\n",
      "ctc-dro-main/node_modules/x/index.js": "skip\n",
    },
  });

  expect(project).toMatchObject({ key: "ctc-dro", title: "CTC DRO", paperPath: "paper/ctc-dro.pdf" });
  const root = testApp.app.projects.dir(project.key);
  expect(fs.readdirSync(root).sort()).toEqual(["code", "paper"]);
  expect(fs.readdirSync(path.join(root, "code"))).toEqual(["train.py"]);

  const again = await uploadProject(testApp.app, workspace, { title: "CTC DRO" });
  expect(again.key).toBe("ctc-dro-2");
});

test("a title two papers share asks the user which one instead of failing", async () => {
  const { workspace, testApp, call } = await setup();
  const first = await uploadProject(testApp.app, workspace, { title: "CTC DRO" });
  const second = await uploadProject(testApp.app, workspace, { title: "CTC DRO" });
  const matches = expect.arrayContaining([{ key: first.key, title: "CTC DRO" }, { key: second.key, title: "CTC DRO" }]);

  for (const [name, args] of [
    ["ask_reviewer", { projectKey: "CTC DRO", question: "Is eq. 3 right?", summary: "Check eq. 3" }],
    ["quick_answer", { projectKey: "CTC DRO", question: "What is CTC?" }],
    ["open_paper", { projectKey: "CTC DRO" }],
    ["highlight_pdf_text", { projectKey: "CTC DRO", quote: "CTC" }],
  ] as const) {
    expect(await call(name, args)).toMatchObject({ needsClarification: true, matches });
  }
  expect(testApp.app.review.busy(first.key) + testApp.app.review.busy(second.key)).toBe(0);
  await expect(call("ask_reviewer", { projectKey: "No such paper", question: "Q", summary: "S" })).rejects.toThrow();
});

test("the paper title is read from the first page only, saved, and announced", async () => {
  const { workspace, testApp } = await setup();
  const project = await uploadProject(testApp.app, workspace, { title: "CTC DRO" });
  expect(project.paperTitle).toBeNull();

  await testApp.app.titlePaper(project.key);

  expect(testApp.titlePages).toHaveLength(1);
  expect(testApp.titlePages[0]).toContain("Published as a conference paper at ICLR 2026");
  expect(testApp.titlePages[0]).not.toContain("=== page");
  expect((await testApp.app.projects.get(project.key)).paperTitle)
    .toBe("CTC-DRO: Robust Optimization for Reducing Language Disparities in Speech Recognition");
  expect(testApp.projectEvents).toContainEqual({ projectKey: project.key, type: "project.changed" });
  expect(await testApp.app.projects.untitledPapers()).toEqual([]);
});

test("a title taken from the PDF's file name gives way to the paper's own title; a chosen title stays", async () => {
  const { workspace, testApp } = await setup();
  const pdfName = "ICLR-2026-ctc-dro-robust-optimization-for-reducing-language-disparities-in-speech-recognition-Paper-Conference (2).pdf";
  const fromName = shortTitle(titleFromPdfName(pdfName));
  expect(fromName).toBe("ICLR 2026 ctc dro robust optimization for reducing language");

  const auto = await uploadProject(testApp.app, workspace, { title: fromName, pdfName });
  const chosen = await uploadProject(testApp.app, workspace, { title: "CTC DRO", pdfName });
  await testApp.app.titlePaper(auto.key);
  await testApp.app.titlePaper(chosen.key);

  expect((await testApp.app.projects.get(auto.key)).title)
    .toBe("CTC-DRO: Robust Optimization for Reducing Language Disparities in Speech Recognition");
  expect((await testApp.app.projects.get(chosen.key)).title).toBe("CTC DRO");
});

test("an older project titled with the whole PDF file name takes its paper's title on boot", async () => {
  const workspace: TestWorkspace = createTestWorkspace("review-boot-title");
  const pdfName = "ICLR-2026-ctc-dro-Paper-Conference (2).pdf";
  const first = await createTestApp(workspace);
  const project = await uploadProject(first.app, workspace, { title: titleFromPdfName(pdfName), pdfName });
  await first.app.projects.setPaperTitle(project.key, "CTC-DRO: Robust Optimization for Reducing Language Disparities in Speech Recognition");
  await first.close();

  const second = await createTestApp(workspace);
  cleanups.push(async () => {
    await second.close();
    workspace.cleanup();
  });
  expect((await second.app.projects.get(project.key)).title)
    .toBe("CTC-DRO: Robust Optimization for Reducing Language Disparities in Speech Recognition");
});

test("a project takes at most one PDF, code is optional, and a failed create leaves nothing behind", async () => {
  const { workspace, testApp } = await setup();
  const uploadDir = path.join(workspace.root, "bad-upload");
  fs.mkdirSync(path.join(uploadDir, "paper"), { recursive: true });
  const fromQuestion = await testApp.app.projects.createFromUpload({ title: "From a question", uploadDir });
  expect(fromQuestion.paperPath).toBeNull();
  expect(fs.readdirSync(testApp.app.projects.dir(fromQuestion.key))).toEqual([]);
  expect(await testApp.app.projects.untitledPapers()).toEqual([]);
  await testApp.app.projects.remove({ projectKey: fromQuestion.key, confirmTitle: "From a question" });

  fs.writeFileSync(path.join(uploadDir, "paper", "a.pdf"), "%PDF-1.4");
  fs.writeFileSync(path.join(uploadDir, "paper", "b.pdf"), "%PDF-1.4");
  await expect(testApp.app.projects.createFromUpload({ title: "Two PDFs", uploadDir }))
    .rejects.toThrow("a project takes at most one PDF, got 2");
  fs.rmSync(path.join(uploadDir, "paper", "b.pdf"));
  const paperOnly = await testApp.app.projects.createFromUpload({ title: "Paper Only", uploadDir });
  expect(fs.readdirSync(testApp.app.projects.dir(paperOnly.key))).toEqual(["paper"]);
  await testApp.app.projects.remove({ projectKey: paperOnly.key, confirmTitle: "Paper Only" });

  fs.writeFileSync(path.join(uploadDir, "paper", "a.pdf"), "%PDF-1.4");
  await expect(testApp.app.projects.createFromUpload({ title: "Bad Link", uploadDir, codeUrl: "https://gitlab.com/a/b" }))
    .rejects.toThrow("the code link must look like https://github.com/owner/repo");

  fs.writeFileSync(path.join(uploadDir, "code.zip"), "not a zip");
  await expect(testApp.app.projects.createFromUpload({ title: "Both", uploadDir, codeUrl: "https://github.com/a/b" }))
    .rejects.toThrow("give the code as a zip or a GitHub link, not both");

  await expect(testApp.app.projects.createFromUpload({ title: "Broken Zip", uploadDir })).rejects.toThrow();
  expect(fs.existsSync(testApp.app.projects.dir("broken-zip"))).toBe(false);

  fs.writeFileSync(path.join(uploadDir, "paper", "a.pdf"), "%PDF-1.4");
  fs.truncateSync(path.join(uploadDir, "code.zip"), MAX_CODE_ZIP_BYTES + 1);
  await expect(testApp.app.projects.createFromUpload({ title: "Huge Code", uploadDir }))
    .rejects.toThrow("the code zip exceeds the 100 MB limit");
  expect(await testApp.app.projects.list()).toEqual([]);
});

test("the reviewer keeps one thread per project and runs in the project folder", async () => {
  const { workspace, testApp, call, turns, opens } = await setup();
  const project = await uploadProject(testApp.app, workspace, { title: "Thread" });

  await expect(call("ask_reviewer", { projectKey: project.key, question: "Does train.py match Eq. 3?", summary: "Code vs Eq. 3" }))
    .resolves.toMatchObject({ asked: true });
  await expect(call("ask_reviewer", { projectKey: project.key, question: "And Eq. 4?", summary: "Eq. 4" }))
    .resolves.toMatchObject({ asked: true, queued: "an earlier question on this project is still running; this one runs next" });
  await waitFor(() => testApp.reviewerEvents.filter((event) => event.type === "reviewer.finished").length === 2 || undefined);

  expect(opens).toEqual([{ threadId: null }]);
  expect(turns.map((turn) => turn.threadId)).toEqual(["thread-1", "thread-1"]);
  expect(turns[0]!.policy.workingDirectory).toBe(testApp.app.projects.dir(project.key));
  expect(Object.keys(turns[0]!.policy.env).sort()).toEqual(expect.arrayContaining(["CODEX_HOME", "PATH"]));
  expect(Object.keys(turns[0]!.policy.env).some((name) => name.startsWith("GALI_"))).toBe(false);
  expect(turns[0]!.policy.env.MPLBACKEND).toBe("Agg");
  expect(fs.readFileSync(path.join(turns[0]!.policy.env.CODEX_HOME!, "AGENTS.md"), "utf8")).toContain("# Paper reviewer");
  expect(fs.readdirSync(path.join(turns[0]!.policy.env.CODEX_HOME!, "skills"))).toEqual(["gali-paper-correctness"]);
  expect(turns[0]!.input).toMatch(/^Paper: paper\/ctc-dro\.pdf\. Text copy: paper\/ctc-dro\.pdf\.txt /);
  expect(fs.readFileSync(path.join(testApp.app.projects.dir(project.key), "paper/ctc-dro.pdf.txt"), "utf8")).toContain("=== page 1 ===");
  expect(turns[0]!.input).toContain("Does train.py match Eq. 3?");
  expect((await testApp.app.projects.getRow(project.key)).reviewThreadId).toBe("thread-1");

  expect(testApp.reviewerEvents.map((event) => event.type)).toEqual([
    "reviewer.started",
    "reviewer.started",
    "reviewer.finished",
    "reviewer.finished",
  ]);
  expect(testApp.projectEvents).toEqual([
    { projectKey: project.key, type: "project.changed" },
    { projectKey: project.key, type: "project.changed" },
  ]);
  expect(testApp.app.review.busy()).toBe(0);
});

test("a new project is always a paper review", async () => {
  const { call } = await setup();
  await expect(call("open_new_project", {})).resolves.toMatchObject({ note: "The user picks the PDF and may add its code in the dialog." });
});

test("after research mode is gone, its threads start over once and other threads are kept", async () => {
  const workspace: TestWorkspace = createTestWorkspace("review-research-reset");
  const first = await createTestApp(workspace);
  const project = await uploadProject(first.app, workspace, { title: "Old thread" });
  await first.app.projects.setReviewThread(project.key, "thread-research");
  await first.close();
  const flag = path.join(workspace.dataDir, "research-mode");
  fs.writeFileSync(flag, "");

  const second = await createTestApp(workspace);
  expect((await second.app.projects.getRow(project.key)).reviewThreadId).toBeNull();
  expect(fs.existsSync(flag)).toBe(false);
  await second.app.projects.setReviewThread(project.key, "thread-review");
  await second.close();

  const third = await createTestApp(workspace);
  cleanups.push(async () => {
    await third.close();
    workspace.cleanup();
  });
  expect((await third.app.projects.getRow(project.key)).reviewThreadId).toBe("thread-review");
});

test("a failed reviewer turn is reported, and the next question still runs", async () => {
  let first = true;
  const provider = createFakeProvider(() => {
    if (first) {
      first = false;
      throw new Error("gateway down");
    }
    return "recovered";
  });
  const { workspace, testApp, call } = await setup(provider);
  const project = await uploadProject(testApp.app, workspace, { title: "Flaky" });

  await call("ask_reviewer", { projectKey: project.key, question: "one", summary: "one" });
  await call("ask_reviewer", { projectKey: project.key, question: "two", summary: "two" });
  await waitFor(() => testApp.reviewerEvents.filter((event) => event.type === "reviewer.finished").length === 2 || undefined);

  expect(testApp.reviewerEvents.filter((event) => event.type === "reviewer.finished")).toEqual([
    { projectKey: project.key, type: "reviewer.finished", status: "failed", error: "gateway down" },
    { projectKey: project.key, type: "reviewer.finished", status: "succeeded", message: "recovered" },
  ]);
});

test("review.json is checked against the paper and code, and a broken one gets one repair turn", async () => {
  const QUOTE = "CTC-DRO consistently outperforms group DRO and CTC-based baseline models";
  let root = "";
  let turn = 0;
  const finding = (id: string, refs: unknown[]) => ({ id, severity: "serious", title: `Title ${id}`, body: "Body.", refs });
  const write = (findings: unknown[]) =>
    fs.writeFileSync(path.join(root, "review.json"), JSON.stringify({ title: "Review", summary: "Summary.", findings }));
  const good = finding("f1", [{ paper: { page: 1, quote: QUOTE } }, { code: { path: "code/train.py", lines: [1, 1] } }]);
  const provider = createFakeProvider(() => {
    turn += 1;
    if (turn === 1) {
      write([good, finding("f2", [
        { paper: { page: 3, quote: "this sentence is not in the paper" } },
        { code: { path: "code/train.py", lines: [1, 9] } },
        { code: { path: "../outside.py", lines: [1, 1] } },
      ])]);
    }
    if (turn === 2) write([good, finding("f2", [{ code: { path: "code/train.py", lines: [1, 1] } }])]);
    if (turn === 3) write([good]);
    return `answer ${turn}`;
  });
  const { workspace, testApp, call, turns } = await setup(provider);
  const project = await uploadProject(testApp.app, workspace, { title: "Checked" });
  root = testApp.app.projects.dir(project.key);
  await expect(testApp.app.reviewDocuments.read(project.key)).resolves.toBeNull();

  await call("ask_reviewer", { projectKey: project.key, question: "Review it", summary: "Review" });
  await waitFor(() => (turns.length === 2 && testApp.app.review.busy() === 0) || undefined);

  expect(turns[1]!.input).toContain("f2 ref 1: the quote is not in the paper");
  expect(turns[1]!.input).toContain("f2 ref 2: code/train.py has 1 lines, not 9");
  expect(turns[1]!.input).toContain("f2 ref 3: ../outside.py is not a file in the project");
  expect(turns[1]!.threadId).toBe("thread-1");
  expect(testApp.reviewerEvents.filter((event) => event.type === "reviewer.finished")).toEqual([
    { projectKey: project.key, type: "reviewer.finished", status: "succeeded", message: "answer 1" },
  ]);
  const review = await testApp.app.reviewDocuments.read(project.key);
  expect(review).toMatchObject({ problems: [], document: { findings: [{ id: "f1" }, { id: "f2" }] } });
  expect(review!.anchors["f1:0"]).toMatchObject({ page: 1, rects: expect.arrayContaining([expect.any(Object)]) as unknown });

  await call("ask_reviewer", { projectKey: project.key, question: "Tighten it", summary: "Tighten" });
  await waitFor(() => (turns.length === 4 && testApp.app.review.busy() === 0) || undefined);
  expect(turns[3]!.input).toContain("finding f2 disappeared");
  expect(testApp.projectEvents).toHaveLength(4);
});

test("a full review runs in the background: Leo answers meanwhile, then reports it, and only then is review.json checked", async () => {
  let root = "";
  const provider = createFakeProvider((input, session) => {
    if (input.includes("Review it")) {
      session.startSubagent();
      return "The review has started.";
    }
    if (input.includes("What is Eq. 3?")) {
      fs.writeFileSync(path.join(root, "review.json"), JSON.stringify({
        title: "Review",
        summary: "Summary.",
        findings: [{ id: "f1", severity: "serious", title: "T", body: "B.", refs: [{ paper: { page: 1, quote: "this sentence is not in the paper" } }] }],
      }));
      return "Eq. 3 is the loss.";
    }
    if (input.includes("The background job finished")) return "One serious issue; it is in the review.";
    return "fixed";
  });
  const { workspace, testApp, call, turns } = await setup(provider);
  const project = await uploadProject(testApp.app, workspace, { title: "Background" });
  root = testApp.app.projects.dir(project.key);
  const finished = () => testApp.reviewerEvents.filter((event) => event.type === "reviewer.finished");
  const reviewing = () => testApp.reviewerEvents.filter((event) => event.type === "reviewer.reviewing");

  await call("ask_reviewer", { projectKey: project.key, question: "Review it", summary: "Review" });
  await waitFor(() => testApp.app.review.reviewing(project.key) || undefined);
  expect(reviewing()).toEqual([{ projectKey: project.key, type: "reviewer.reviewing", running: true }]);
  await expect(call("ask_reviewer", { projectKey: project.key, question: "What is Eq. 3?", summary: "Eq. 3" }))
    .resolves.toMatchObject({ asked: true, reviewRunning: expect.any(String) as unknown });
  await waitFor(() => (finished().length === 2 && testApp.app.review.busy(project.key) === 0) || undefined);
  expect(testApp.app.review.busy()).toBe(1);
  expect(turns).toHaveLength(2);

  provider.sessions[0]!.finishSubagent("completed", "Found one serious issue.");
  expect(reviewing()).toEqual([
    { projectKey: project.key, type: "reviewer.reviewing", running: true },
    { projectKey: project.key, type: "reviewer.reviewing", running: false },
  ]);
  await waitFor(() => (turns.length === 4 && testApp.app.review.busy() === 0) || undefined);
  expect(turns[2]!.input).toContain("The background job finished. Its last message:\nFound one serious issue.");
  expect(turns[3]!.input).toContain("f1 ref 1: the quote is not in the paper");
  expect(testApp.reviewerEvents.filter((event) => event.type === "reviewer.started").map((event) => event.summary))
    .toEqual(["Review", "Eq. 3", "Reporting the finished job"]);
  expect(finished()).toEqual([
    { projectKey: project.key, type: "reviewer.finished", status: "succeeded", message: "The review has started." },
    { projectKey: project.key, type: "reviewer.finished", status: "succeeded", message: "Eq. 3 is the loss." },
    { projectKey: project.key, type: "reviewer.finished", status: "succeeded", message: "One serious issue; it is in the review." },
  ]);
});

test("quick_answer sends the paper text to the fast model", async () => {
  const { workspace, testApp, call } = await setup();
  const project = await uploadProject(testApp.app, workspace, { title: "Quick" });
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({
    output: [{ type: "message", content: [{ type: "output_text", text: "They use group DRO." }] }],
  })));
  vi.stubGlobal("fetch", fetchMock);

  await expect(call("quick_answer", { projectKey: project.key, question: "What baseline?" }))
    .resolves.toEqual({ answer: "They use group DRO." });
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/responses");
  const body = JSON.parse(init.body as string) as { input: string };
  expect(body.input).toContain("What baseline?");
  expect(body.input).toContain("=== page 1 ===");
  vi.unstubAllEnvs();
});

test("an old project with no PDF has no draft, and PDF-only tools refuse it", async () => {
  const { workspace, testApp, call, turns } = await setup();
  const uploadDir = path.join(workspace.root, "question-only");
  fs.mkdirSync(uploadDir, { recursive: true });
  const project = await testApp.app.projects.createFromUpload({ title: "Steps", uploadDir });

  await call("ask_reviewer", { projectKey: project.key, question: "Does the gain hold at 40k steps?", summary: "Plan the steps test" });
  await waitFor(() => testApp.reviewerEvents.some((event) => event.type === "reviewer.finished") || undefined);
  expect(turns[0]!.input).toMatch(/^This project has no PDF\.\n/);
  expect(turns[0]!.input).not.toContain("draft");

  await expect(call("open_paper", { projectKey: project.key, page: 2 })).rejects.toThrow("this project has no PDF");
  await expect(call("set_viewer_page", { projectKey: project.key, page: 2 })).rejects.toThrow("this project has no PDF");
  await expect(call("list_pdf_notes", { projectKey: project.key })).rejects.toThrow("this project has no PDF");
  await expect(call("show_tab", { projectKey: project.key, tab: "notes" })).rejects.toThrow("this project has no PDF");
  await expect(call("show_tab", { projectKey: project.key, tab: "review" })).resolves.toEqual({ shown: "review" });
  await expect(call("quick_answer", { projectKey: project.key, question: "What is in the code?" }))
    .resolves.toEqual({ noPaper: true, note: "This project has no PDF to look up. Call ask_reviewer with the same question." });
});

test("there is no download_draft tool, even for a project with a draft on disk", async () => {
  const { workspace, testApp, call } = await setup();
  const project = await uploadProject(testApp.app, workspace, { title: "Written" });
  fs.mkdirSync(path.join(testApp.app.projects.dir(project.key), "draft"), { recursive: true });
  fs.writeFileSync(path.join(testApp.app.projects.dir(project.key), "draft/paper.md"), "# Written\n");

  await expect(call("download_draft", { projectKey: project.key })).rejects.toThrow("unknown tool 'download_draft'");
  expect(testApp.navEvents).toEqual([]);
});

test("navigation tools validate paths and emit the matching nav events", async () => {
  const { workspace, testApp, call } = await setup();
  const project = await uploadProject(testApp.app, workspace, {
    title: "Nav",
    code: { "repo/train.py": "print('x')\n" },
  });

  await expect(call("open_code_file", { projectKey: project.key, path: "code/train.py" }))
    .resolves.toMatchObject({ opened: true, display: "full" });
  await expect(call("open_code_file", { projectKey: project.key, path: "code/missing.py" }))
    .rejects.toThrow(/file not found: code\/missing\.py; in code: code\/train\.py/);
  await expect(call("open_code_file", { projectKey: project.key, path: "paper/ctc-dro.pdf" }))
    .rejects.toThrow(/use open_paper/);
  await call("open_code_file", { projectKey: project.key, path: "code/train.py", lines: [1] });
  await call("open_paper", { projectKey: project.key, page: 3 });
  await call("show_tab", { projectKey: project.key, tab: "notes" });
  await call("show_tab", { projectKey: project.key, tab: "review" });
  for (const tab of ["paper", "lab", "agent"]) {
    await expect(call("show_tab", { projectKey: project.key, tab }))
      .rejects.toThrow(/tab must be review, notes, chat, code/);
  }
  await expect(call("open_project", { query: "nav" })).resolves.toMatchObject({ opened: true });

  expect(testApp.navEvents).toEqual([
    { type: "open_code_file", projectKey: project.key, path: "code/train.py" },
    { type: "open_code_file", projectKey: project.key, path: "code/train.py", lines: [1, 1] },
    { type: "open_paper", projectKey: project.key, page: 3 },
    { type: "show_tab", projectKey: project.key, tab: "notes" },
    { type: "show_tab", projectKey: project.key, tab: "review" },
    { type: "open_project", projectKey: project.key },
  ]);
});

test("the project actions sheet does not claim it opened, since desktop has no sheet", async () => {
  const { workspace, testApp, call } = await setup();
  const project = await uploadProject(testApp.app, workspace, { title: "Sheet", code: { "repo/a.py": "x\n" } });

  const result = await call("open_project_actions", { projectKey: project.key });
  expect(result).not.toHaveProperty("opened");
  expect(result).toMatchObject({ projectKey: project.key, note: expect.stringContaining("On desktop nothing opened") });
  expect(testApp.navEvents).toEqual([{ type: "open_project_actions", projectKey: project.key }]);
});

test("delete_project asks for the title, then removes the folder and the notes", async () => {
  const { workspace, testApp, call } = await setup();
  const project = await uploadProject(testApp.app, workspace, { title: "Gone Soon" });
  await call("add_pdf_note", { projectKey: project.key, page: 1, text: "note" });

  await expect(call("delete_project", { query: "gone" }))
    .resolves.toMatchObject({ needsConfirmation: true, warning: expect.not.stringMatching(/paper/i) });
  await expect(call("delete_project", { query: "gone", confirmTitle: "gone soon" }))
    .resolves.toEqual({ deleted: true, projectKey: project.key, title: "Gone Soon" });
  expect(fs.existsSync(testApp.app.projects.dir(project.key))).toBe(false);
  expect(fs.existsSync(path.join(workspace.dataDir, "pdf-annotations", `${project.key}.json`))).toBe(false);
});
