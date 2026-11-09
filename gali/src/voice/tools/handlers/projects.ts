import { PAPER_DIR, PROJECT_TABS } from "../../../../shared/domain/contracts.js";
import { viewerDisplay } from "../../../adapters/fs/project-files.js";
import { quickAnswer } from "../../../adapters/openai/quick-answer.js";
import { requirePaperPath } from "../../../services/projects/project-service.js";
import type { VoiceToolName } from "../schemas.js";
import type { ToolContext, ToolHandlerGroup } from "../types.js";

export const PROJECT_TOOL_NAMES = [
  "list_projects",
  "open_project",
  "go_home",
  "open_new_project",
  "close_new_project",
  "delete_project",
  "rename_project",
  "open_paper",
  "set_viewer_page",
  "open_code_file",
  "show_tab",
  "project_source",
  "quick_answer",
  "ask_reviewer",
  "cancel_reviewer",
  "open_project_actions",
  "close_project_actions",
  "navigate_back",
  "open_transcript",
  "close_transcript",
  "set_mic_muted",
  "end_voice",
] as const satisfies readonly VoiceToolName[];

type ProjectToolName = (typeof PROJECT_TOOL_NAMES)[number];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function requiredText(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} must not be empty`);
  return text;
}

function optionalPage(value: unknown): number | undefined {
  return value === undefined ? undefined : Math.max(1, Math.trunc(Number(value)));
}

async function paperPage(app: ToolContext["app"], projectKey: string, value: unknown): Promise<number | undefined> {
  const page = optionalPage(value);
  if (page === undefined) return undefined;
  const pages = (await app.paperText(projectKey)).match(/^=== page \d+/gm)!.length;
  if (page > pages) {
    throw new Error(`the PDF has ${pages} pages; ${page} is not one of them (a number printed in the PDF is not a PDF page). Use N from the "=== page N ===" marker.`);
  }
  return page;
}

export class AmbiguousProject extends Error {
  constructor(readonly matches: Array<{ key: string; title: string }>) {
    super(`${matches.length} projects match: ${matches.map((project) => project.key).join(", ")}`);
  }
}

// The model may pass a spoken title ("Attention paper") where a key is expected.
export async function resolveProjectKey(app: ToolContext["app"], raw: unknown): Promise<string> {
  const value = String(raw);
  const all = await app.projects.list();
  if (all.some((project) => project.key === value)) return value;
  const target = normalize(value);
  const matches = all.filter((project) =>
    normalize(project.key) === target || normalize(project.title) === target
  );
  if (matches.length === 1) return matches[0]!.key;
  if (matches.length > 1) throw new AmbiguousProject(matches.map(({ key, title }) => ({ key, title })));
  return value;
}

async function matchProjects(app: ToolContext["app"], args: Record<string, unknown>) {
  const all = await app.visibleProjects();
  const exact = args.projectKey === undefined
    ? undefined
    : all.find((project) => project.key === String(args.projectKey));
  if (exact) return [exact];
  const query = normalize(String(args.query ?? args.projectKey ?? ""));
  const matches = all.filter((project) =>
    normalize(project.key).includes(query) || normalize(project.title).includes(query)
  );
  if (matches.length <= 1) return matches;
  // Exact title/key match beats substring matches ("Adam" vs "Adam 2").
  const exactByName = matches.filter((project) =>
    normalize(project.key) === query || normalize(project.title) === query
  );
  return exactByName.length === 1 ? exactByName : matches;
}

export function projectHandlers(context: ToolContext): ToolHandlerGroup<ProjectToolName> {
  const { app, onNav } = context;

  async function existing(args: Record<string, unknown>): Promise<string> {
    const projectKey = await resolveProjectKey(app, args.projectKey);
    await app.projects.get(projectKey);
    return projectKey;
  }

  return {
    async list_projects() {
      return { projects: (await app.visibleProjects()).map(({ key, title }) => ({ key, title })) };
    },

    async open_project(args) {
      const matches = await matchProjects(app, args);
      if (matches.length !== 1) {
        return { needsClarification: true, matches: matches.map(({ key, title }) => ({ key, title })) };
      }
      const project = matches[0]!;
      onNav({ type: "open_project", projectKey: project.key });
      return { opened: true, project: { key: project.key, title: project.title, paper: project.paperPath } };
    },

    async go_home() {
      onNav({ type: "open_home" });
      return { opened: true };
    },

    async open_new_project(args) {
      const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
      onNav({ type: "open_new_project", ...(title === undefined ? {} : { title }) });
      return { opened: true, note: "The user picks the PDF and may add its code in the dialog." };
    },

    async close_new_project() {
      onNav({ type: "close_new_project" });
      return { closed: true };
    },

    async delete_project(args) {
      const matches = await matchProjects(app, args);
      if (matches.length !== 1) {
        return { needsClarification: true, matches: matches.map(({ key, title }) => ({ key, title })) };
      }
      const project = matches[0]!;
      const confirmTitle = typeof args.confirmTitle === "string" ? args.confirmTitle.trim() : "";
      if (!confirmTitle || normalize(confirmTitle) !== normalize(project.title)) {
        return {
          needsConfirmation: true,
          project: { key: project.key, title: project.title },
          warning:
            "Deleting permanently removes all its files, its notes, and its findings. Ask the user to confirm the exact project title, then call again with confirmTitle.",
        };
      }
      const result = await app.deleteProject({ projectKey: project.key, confirmTitle: project.title });
      onNav({ type: "open_home" });
      return result;
    },

    async rename_project(args) {
      const project = await app.renameProject(
        await resolveProjectKey(app, args.projectKey),
        requiredText(args.title, "title"),
      );
      return { renamed: true, projectKey: project.key, title: project.title };
    },

    async open_paper(args) {
      const project = await app.projects.get(await resolveProjectKey(app, args.projectKey));
      const projectKey = project.key;
      const paperPath = requirePaperPath(project);
      const page = await paperPage(app, projectKey, args.page);
      onNav({ type: "open_paper", projectKey, ...(page === undefined ? {} : { page }) });
      return { opened: true, projectKey, path: paperPath, ...(page === undefined ? {} : { page }) };
    },

    async set_viewer_page(args) {
      const project = await app.projects.get(await resolveProjectKey(app, args.projectKey));
      const projectKey = project.key;
      const paperPath = requirePaperPath(project);
      const page = await paperPage(app, projectKey, args.page);
      const direction = args.direction === "next" || args.direction === "prev" ? args.direction : undefined;
      if (page === undefined && direction === undefined) throw new Error("pass page or direction");
      onNav({
        type: "set_viewer_page",
        projectKey,
        ...(page === undefined ? {} : { page }),
        ...(direction === undefined ? {} : { direction }),
      });
      return {
        turned: true,
        projectKey,
        path: paperPath,
        ...(page === undefined ? {} : { page }),
        ...(direction === undefined ? {} : { direction }),
      };
    },

    async open_code_file(args) {
      const projectKey = await existing(args);
      const path = requiredText(args.path, "path").replaceAll("\\", "/").replace(/^\.\//, "");
      if (path.startsWith(`${PAPER_DIR}/`) && path.toLowerCase().endsWith(".pdf")) {
        throw new Error("that is the PDF — use open_paper");
      }
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const listed = await app.projects.tree(projectKey, parent, 1);
      const entry = listed.entries.find((file) => file.path === path);
      if (!entry) {
        const nearby = listed.entries.map((file) => file.path).slice(0, 20);
        throw new Error(`file not found: ${path}; in ${parent || "the project root"}: ${nearby.join(", ") || "nothing"}`);
      }
      const raw = Array.isArray(args.lines) ? args.lines : [];
      const first = Number(raw[0]);
      const last = Number(raw[1] ?? raw[0]);
      const lines: [number, number] | undefined = Number.isInteger(first) && Number.isInteger(last) && first >= 1 && last >= first
        ? [first, last]
        : undefined;
      onNav({ type: "open_code_file", projectKey, path, ...(lines ? { lines } : {}) });
      return { opened: true, projectKey, path, kind: entry.kind, display: viewerDisplay(path, entry.bytes) };
    },

    async show_tab(args) {
      const projectKey = await existing(args);
      const tab = PROJECT_TABS.find((name) => name === args.tab);
      if (!tab) throw new Error(`tab must be ${PROJECT_TABS.join(", ")}`);
      if (tab === "notes") requirePaperPath(await app.projects.get(projectKey));
      onNav({ type: "show_tab", projectKey, tab });
      return { shown: tab };
    },

    async project_source(args) {
      return app.projects.source({
        projectKey: await resolveProjectKey(app, args.projectKey),
        action: String(args.action) as "tree" | "read" | "search",
        ...(args.path === undefined ? {} : { path: String(args.path) }),
        ...(args.query === undefined ? {} : { query: String(args.query) }),
        ...(args.depth === undefined ? {} : { depth: Number(args.depth) }),
        ...(args.offset === undefined ? {} : { offset: Number(args.offset) }),
        ...(args.limit === undefined ? {} : { limit: Number(args.limit) }),
      });
    },

    async quick_answer(args) {
      const projectKey = await existing(args);
      const question = requiredText(args.question, "question");
      if ((await app.projects.get(projectKey)).paperPath === null) {
        return { noPaper: true, note: "This project has no PDF to look up. Call ask_reviewer with the same question." };
      }
      const answer = await quickAnswer({ question, paperText: await app.paperText(projectKey) });
      return { answer };
    },

    async ask_reviewer(args) {
      const projectKey = await existing(args);
      const queued = app.review.busy(projectKey) > 0;
      app.review.ask(projectKey, requiredText(args.question, "question"), requiredText(args.summary, "summary"));
      return {
        asked: true,
        projectKey,
        ...(queued ? { queued: "an earlier question on this project is still running; this one runs next" } : {}),
        ...(app.review.reviewing(projectKey) ? { reviewRunning: "a long job is running in the background; this question is answered alongside it" } : {}),
        note: "The answer arrives as a background update.",
      };
    },

    async cancel_reviewer(args) {
      const projectKey = await existing(args);
      return { cancelled: app.review.cancel(projectKey) };
    },

    async open_project_actions(args) {
      const projectKey = await existing(args);
      onNav({ type: "open_project_actions", projectKey });
      return {
        projectKey,
        note: "This sheet opens on phone only. On desktop nothing opened: tell the user to click ⋯ More actions themselves, then the item they want (Browse code, Account, Delete).",
      };
    },

    async close_project_actions(args) {
      const projectKey = await existing(args);
      onNav({ type: "close_project_actions", projectKey });
      return { closed: true, projectKey };
    },

    async navigate_back() {
      onNav({ type: "navigate_back" });
      return { navigated: true };
    },

    async open_transcript() {
      onNav({ type: "open_transcript" });
      return { opened: true };
    },

    async close_transcript() {
      onNav({ type: "close_transcript" });
      return { closed: true };
    },

    async set_mic_muted(args) {
      const muted = Boolean(args.muted);
      onNav({ type: "set_mic_muted", muted });
      return { muted };
    },

    async end_voice() {
      onNav({ type: "end_voice" });
      return { ended: true };
    },
  };
}
