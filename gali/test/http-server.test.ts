import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ProjectEvent, ReviewerEvent } from "../shared/domain/contracts.js";
import type { AppContext } from "../src/application/app-context.js";
import { createActivityTracker, type ActivityTracker } from "../src/http/idle-sleep.js";
import { createGaliHttpServer, type GaliHttpServer } from "../src/http/server.js";
import { createTestApp, uploadProject, waitFor } from "./support/test-app.js";
import { createTestWorkspace, type TestWorkspace } from "./test.config.js";

let server: GaliHttpServer | null = null;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await server?.close();
  server = null;
  for (const cleanup of cleanups.splice(0)) await cleanup();
  delete process.env.GALI_BACKEND_VERSION;
});

async function startServer(
  app: AppContext = {} as AppContext,
  opts: { activity?: ActivityTracker; secret?: string | null; sseHeartbeatMs?: number } = {},
): Promise<GaliHttpServer> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      server = await createGaliHttpServer(app, {
        port: 20_000 + Math.floor(Math.random() * 20_000),
        host: "127.0.0.1",
        secret: opts.secret ?? null,
        activity: opts.activity ?? createActivityTracker(),
        ...(opts.sseHeartbeatMs === undefined ? {} : { sseHeartbeatMs: opts.sseHeartbeatMs }),
      });
      return server;
    } catch {
      // Port collision: try another.
    }
  }
  throw new Error("could not bind a test port");
}

async function realApp(): Promise<{ workspace: TestWorkspace; testApp: Awaited<ReturnType<typeof createTestApp>> }> {
  const workspace = createTestWorkspace("http");
  const testApp = await createTestApp(workspace);
  cleanups.push(async () => {
    await testApp.close();
    workspace.cleanup();
  });
  return { workspace, testApp };
}

async function recent(port: number, since?: number) {
  const res = await fetch(`http://127.0.0.1:${port}/events/recent${since === undefined ? "" : `?since=${since}`}`);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    latest: number;
    reviewer: Array<ReviewerEvent & { seq: number }>;
    projects: Array<ProjectEvent & { seq: number }>;
  };
}

test("reviewer and project events share one seq counter and replay after a gap", async () => {
  const srv = await startServer();
  srv.publishReviewer({ projectKey: "demo", type: "reviewer.started", question: "q", summary: "s" });
  srv.publishProject({ projectKey: "demo", type: "project.changed" });
  srv.publishReviewer({ projectKey: "demo", type: "reviewer.finished", status: "succeeded", message: "ok" });

  const all = await recent(srv.port, 0);
  expect(all.latest).toBe(3);
  expect(all.reviewer.map((event) => event.seq)).toEqual([1, 3]);
  expect(all.projects.map((event) => event.seq)).toEqual([2]);

  const tail = await recent(srv.port, 2);
  expect(tail.reviewer).toEqual([
    { projectKey: "demo", type: "reviewer.finished", status: "succeeded", message: "ok", seq: 3 },
  ]);
  expect(tail.projects).toEqual([]);

  expect((await recent(srv.port)).reviewer).toEqual([]);
});

test("an idle event stream sends a heartbeat comment so clients can detect a dead connection", async () => {
  const srv = await startServer(undefined, { sseHeartbeatMs: 30 });
  const res = await fetch(`http://127.0.0.1:${srv.port}/events`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!buffer.includes(": ping\n\n")) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  expect(buffer.startsWith("event: ready\n")).toBe(true);
});

test("projects, tree, file, and media routes serve the project folder", async () => {
  const { workspace, testApp } = await realApp();
  const project = await uploadProject(testApp.app, workspace, {
    title: "CTC DRO",
    code: { "ctc-dro-main/train.py": "print('train')\n", "ctc-dro-main/data/labels.csv": "a,b\n" },
  });
  const srv = await startServer(testApp.app);
  const base = `http://127.0.0.1:${srv.port}`;

  const list = (await (await fetch(`${base}/projects`)).json()) as Array<{ key: string; paperPath: string }>;
  expect(list.map((item) => [item.key, item.paperPath])).toEqual([[project.key, "paper/ctc-dro.pdf"]]);

  const tree = (await (await fetch(`${base}/projects/${project.key}/tree?path=code&depth=1`)).json()) as {
    entries: Array<{ path: string }>;
  };
  expect(tree.entries.map((entry) => entry.path)).toEqual(["code/data/labels.csv", "code/train.py"]);

  const file = (await (await fetch(`${base}/projects/${project.key}/file?path=code/train.py`)).json()) as {
    content: string;
  };
  expect(file.content).toBe("print('train')\n");

  const media = await fetch(`${base}/projects/${project.key}/media?path=paper/ctc-dro.pdf`);
  expect(media.headers.get("content-type")).toBe("application/pdf");
  expect(Buffer.from(await media.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

  const missing = await fetch(`${base}/projects/nope`);
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: "project 'nope' not found" });
});

test("delete needs the exact title and then removes the project", async () => {
  const { workspace, testApp } = await realApp();
  const project = await uploadProject(testApp.app, workspace, { title: "Doomed" });
  const srv = await startServer(testApp.app);
  const del = (confirmTitle: string) => fetch(`http://127.0.0.1:${srv.port}/projects/${project.key}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmTitle }),
  });

  expect((await del("Other")).status).toBe(400);
  const ok = await del("doomed");
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ deleted: true, projectKey: project.key, title: "Doomed" });
  expect(await testApp.app.projects.list()).toEqual([]);
});

test("a project's chat is saved, read back, capped, kept per project, and deleted with the project", async () => {
  const { workspace, testApp } = await realApp();
  const project = await uploadProject(testApp.app, workspace, { title: "Chatty" });
  const other = await uploadProject(testApp.app, workspace, { title: "Quiet" });
  const srv = await startServer(testApp.app);
  const chatUrl = (key: string) => `http://127.0.0.1:${srv.port}/projects/${key}/chat`;
  const save = (key: string, lines: unknown) => fetch(chatUrl(key), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lines }),
  });
  const read = async (key: string) => (await (await fetch(chatUrl(key))).json()) as { lines: unknown[] };

  expect(await read(project.key)).toEqual({ lines: [] });
  const lines = Array.from({ length: 205 }, (_, i) => ({ kind: "message", role: "user", text: `q${i}` }));
  const saved = await save(project.key, lines);
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({ saved: 200 });
  expect((await read(project.key)).lines).toEqual(lines.slice(5));
  expect(await read(other.key)).toEqual({ lines: [] });
  expect((await save(project.key, "nope")).status).toBe(400);
  expect((await save(project.key, [1, 2])).status).toBe(400);
  expect((await fetch(chatUrl("missing"))).status).toBe(400);

  await testApp.app.deleteProject({ projectKey: project.key, confirmTitle: "Chatty" });
  expect(fs.readdirSync(path.join(testApp.app.dataDir, "project-chats"))).toEqual([]);
});

test("research mode, the Lab, and the draft have no routes", async () => {
  const { workspace, testApp } = await realApp();
  const project = await uploadProject(testApp.app, workspace, { title: "Review only" });
  fs.mkdirSync(path.join(testApp.app.projects.dir(project.key), "draft"), { recursive: true });
  fs.writeFileSync(path.join(testApp.app.projects.dir(project.key), "draft/paper.md"), "# Draft\n");
  fs.writeFileSync(path.join(testApp.app.projects.dir(project.key), "lab.json"), "{}\n");
  const srv = await startServer(testApp.app);
  const base = `http://127.0.0.1:${srv.port}`;

  expect((await fetch(`${base}/research-mode`)).status).toBe(404);
  expect((await fetch(`${base}/research-mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on: true }),
  })).status).toBe(404);
  for (const route of ["lab", "draft", "draft/export"]) {
    expect((await fetch(`${base}/projects/${project.key}/${route}`)).status).toBe(404);
  }
});

test("projects without a paper are hidden from the Library and from voice", async () => {
  const { workspace, testApp } = await realApp();
  const paper = await uploadProject(testApp.app, workspace, { title: "Paper" });
  const question = await testApp.app.projects.createFromUpload({ title: "From a question", uploadDir: fs.mkdtempSync(path.join(workspace.root, "empty-")) });
  const srv = await startServer(testApp.app);
  const library = async () => ((await (await fetch(`http://127.0.0.1:${srv.port}/projects`)).json()) as Array<{ key: string }>)
    .map((project) => project.key)
    .sort();
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/realtime/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args, session: "test" }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  expect(await library()).toEqual([paper.key]);
  expect(await tool("list_projects", {})).toMatchObject({ projects: [{ key: paper.key, title: "Paper" }] });
  expect(await tool("open_project", { query: "From a question" })).toMatchObject({ needsClarification: true, matches: [] });
  expect(await testApp.app.projects.get(question.key)).toMatchObject({ key: question.key, paperPath: null });
});

test("tool navigation rides the tool response, and ask_reviewer answers over the event stream", async () => {
  const { workspace, testApp } = await realApp();
  const project = await uploadProject(testApp.app, workspace, { title: "Asked" });
  const srv = await startServer(testApp.app);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${srv.port}/realtime/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, args, session: "test" }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };

  expect(await tool("go_home", {})).toEqual({ opened: true, navEvents: [{ type: "open_home" }] });
  expect(await tool("ask_reviewer", { projectKey: project.key, question: "Is eq. 3 right?", summary: "Check eq. 3" }))
    .toMatchObject({ asked: true });
  const finished = await waitFor(() => testApp.reviewerEvents.find((event) => event.type === "reviewer.finished"));
  expect(finished).toEqual({ projectKey: project.key, type: "reviewer.finished", status: "succeeded", message: "answer 1" });
});

test("a PDF annotation export downloads as an attachment and needs a known format", async () => {
  const { workspace, testApp } = await realApp();
  const project = await uploadProject(testApp.app, workspace, { title: "Notes" });
  await testApp.app.pdfAnnotations.addNote({ projectKey: project.key, path: project.paperPath!, text: "Check this.", page: 1 });
  const srv = await startServer(testApp.app);
  const route = `http://127.0.0.1:${srv.port}/projects/${project.key}/pdf-annotations/export`;

  const res = await fetch(`${route}?format=markdown`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
  expect(res.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''ctc-dro-notes.md");
  expect(await res.text()).toContain("Check this.");
  expect((await fetch(`${route}?format=docx`)).status).toBe(400);
});

test("an upload cannot add data to an existing project", async () => {
  const { workspace, testApp } = await realApp();
  const project = await uploadProject(testApp.app, workspace, { title: "Paper" });
  const srv = await startServer(testApp.app);
  const post = (body: unknown) => fetch(`http://127.0.0.1:${srv.port}/import-uploads`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

  expect((await post({ projectKey: project.key, dataName: "speakers.zip" })).status).toBe(400);
  expect((await testApp.app.projects.list()).map((item) => item.key)).toEqual([project.key]);
});

test("the catch-up poll does not count as user activity", async () => {
  let now = 0;
  const tracker = createActivityTracker(() => now);
  const srv = await startServer(undefined, { activity: tracker });

  now = 100;
  await recent(srv.port, 0);
  expect(tracker.snapshot(0, 50).lastActivityAt).toBe(0);
});

test("with a secret set, unauthenticated callers get nothing and hold nothing awake", async () => {
  process.env.GALI_BACKEND_VERSION = "release-abc123";
  let now = 0;
  const tracker = createActivityTracker(() => now);
  const srv = await startServer(undefined, { activity: tracker, secret: "s3cret" });
  const base = `http://127.0.0.1:${srv.port}`;

  now = 100;
  expect((await fetch(`${base}/health`)).status).toBe(401);
  expect((await fetch(`${base}/health`, { headers: { "x-gali-secret": "nope" } })).status).toBe(401);
  // A rejected request must not touch the idle clock, or an attacker could keep
  // the sandbox billing forever.
  expect(tracker.snapshot(0, 50).lastActivityAt).toBe(0);

  const withHeader = await fetch(`${base}/health`, { headers: { "x-gali-secret": "s3cret" } });
  expect(withHeader.status).toBe(200);
  await expect(withHeader.json()).resolves.toEqual({ ok: true, version: "release-abc123" });
  // EventSource cannot set headers, hence the query-string form.
  expect((await fetch(`${base}/events/recent?secret=s3cret`)).status).toBe(200);
});

test("refuses to listen beyond loopback without a secret", () => {
  for (const host of [undefined, "0.0.0.0"]) {
    expect(() => createGaliHttpServer({} as AppContext, {
      port: 0,
      ...(host ? { host } : {}),
      secret: null,
      activity: createActivityTracker(),
    })).toThrow(/without an HTTP secret/);
  }
  expect(() => createGaliHttpServer({} as AppContext, {
    port: 0,
    secret: " ",
    activity: createActivityTracker(),
  })).toThrow(/empty/);
});
