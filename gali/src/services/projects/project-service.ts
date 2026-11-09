import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  CODE_DIR,
  githubCloneUrl,
  MAX_CODE_ZIP_BYTES,
  PAPER_DIR,
  UPLOAD_CODE_ZIP,
  type DeleteProjectResult,
  type ProjectDto,
} from "../../../shared/domain/contracts.js";
import { isPdfNameTitle } from "../../../shared/domain/project-title.js";
import { slugify } from "../../../shared/domain/slug.js";
import { downloadRepository } from "../../lib/github-archive.js";
import { unwrapSingleFolder, extractZip } from "../../lib/zip.js";
import type { Db } from "../../db/client.js";
import { projects, type Project } from "../../db/schema.js";
import { UserError } from "../../lib/user-error.js";
import type { ProjectFiles } from "../../ports/project-files.js";

export type ProjectService = ReturnType<typeof createProjectService>;

/** The PDF a note or highlight belongs to. */
export function requirePaperPath(project: { paperPath: string | null }): string {
  if (project.paperPath === null) throw new UserError("this project has no PDF");
  return project.paperPath;
}

export type ProjectSourceInput = {
  projectKey: string;
  action: "tree" | "read" | "search";
  path?: string;
  query?: string;
  depth?: number;
  offset?: number;
  limit?: number;
};

function dto(project: Project): ProjectDto {
  return {
    key: project.key,
    title: project.title,
    paperPath: project.paperPath,
    paperTitle: project.paperTitle,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

async function listPdfs(dir: string): Promise<string[]> {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function createProjectService(opts: { db: Db; projectsRoot: string; files: ProjectFiles }) {
  const { db, files } = opts;

  async function getRow(key: string): Promise<Project> {
    const [project] = await db.select().from(projects).where(eq(projects.key, key)).limit(1);
    if (!project) throw new UserError(`project '${key}' not found`);
    return project;
  }

  function dir(projectKey: string): string {
    return path.join(opts.projectsRoot, projectKey);
  }

  async function uniqueKey(title: string): Promise<string> {
    const base = slugify(title) || "paper";
    for (let n = 1; ; n += 1) {
      const key = n === 1 ? base : `${base}-${n}`;
      const [taken] = await db.select({ id: projects.id }).from(projects).where(eq(projects.key, key)).limit(1);
      if (!taken) return key;
    }
  }

  return {
    getRow,
    dir,

    async get(key: string): Promise<ProjectDto> {
      return dto(await getRow(key));
    },

    async list(): Promise<ProjectDto[]> {
      return (await db.select().from(projects).orderBy(desc(projects.updatedAt))).map(dto);
    },

    /**
     * `uploadDir` holds at most one PDF under paper/ and, optionally, the code zip at its root.
     * `codeUrl` is a GitHub repository to clone instead; with neither, the project has no code/.
     */
    async createFromUpload(input: { title: string; uploadDir: string; codeUrl?: string }): Promise<ProjectDto> {
      const title = input.title.trim();
      if (!title) throw new UserError("project title must not be empty");
      const pdfs = await listPdfs(path.join(input.uploadDir, PAPER_DIR));
      if (pdfs.length > 1) throw new UserError(`a project takes at most one PDF, got ${pdfs.length}`);
      const codeZip = path.join(input.uploadDir, UPLOAD_CODE_ZIP);
      const codeZipStat = await fsp.stat(codeZip).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (codeZipStat && codeZipStat.size > MAX_CODE_ZIP_BYTES) {
        throw new UserError("the code zip exceeds the 100 MB limit");
      }
      const cloneUrl = input.codeUrl === undefined ? null : githubCloneUrl(input.codeUrl);
      if (input.codeUrl !== undefined && !cloneUrl) {
        throw new UserError("the code link must look like https://github.com/owner/repo");
      }
      if (codeZipStat && cloneUrl) throw new UserError("give the code as a zip or a GitHub link, not both");

      const key = await uniqueKey(title);
      const root = dir(key);
      await fsp.mkdir(root, { recursive: true });
      try {
        const paperPath = pdfs[0] === undefined ? null : `${PAPER_DIR}/${pdfs[0]}`;
        if (paperPath) {
          await fsp.mkdir(path.join(root, PAPER_DIR), { recursive: true });
          // A fresh file, not a rename or copyFile (both keep the upload's owner):
          // it takes the project folder's group, which lets the hosted Codex user read it.
          await pipeline(fs.createReadStream(path.join(input.uploadDir, paperPath)), fs.createWriteStream(path.join(root, paperPath)));
        }
        if (codeZipStat) {
          await extractZip(codeZip, path.join(root, CODE_DIR));
          await unwrapSingleFolder(path.join(root, CODE_DIR));
        }
        if (cloneUrl) await downloadRepository(cloneUrl, path.join(root, CODE_DIR));
        const [project] = await db.insert(projects).values({ key, title, paperPath }).returning();
        if (!project) throw new Error("project insert returned no row");
        return dto(project);
      } catch (error) {
        await fsp.rm(root, { recursive: true, force: true });
        throw error;
      }
    },

    async rename(projectKey: string, title: string): Promise<ProjectDto> {
      const nextTitle = title.trim();
      if (!nextTitle) throw new UserError("project title must not be empty");
      const current = await getRow(projectKey);
      if (nextTitle === current.title) return dto(current);
      const [project] = await db
        .update(projects)
        .set({ title: nextTitle, updatedAt: new Date() })
        .where(eq(projects.id, current.id))
        .returning();
      if (!project) throw new Error("project update returned no row");
      return dto(project);
    },

    async setPaperTitle(projectKey: string, paperTitle: string): Promise<void> {
      await db.update(projects).set({ paperTitle }).where(eq(projects.key, projectKey));
    },

    async adoptPaperTitle(projectKey: string): Promise<boolean> {
      const project = await getRow(projectKey);
      if (!project.paperTitle || !project.paperPath || project.title === project.paperTitle) return false;
      if (!isPdfNameTitle(project.title, path.basename(project.paperPath))) return false;
      await db.update(projects).set({ title: project.paperTitle }).where(eq(projects.id, project.id));
      return true;
    },

    async untitledPapers(): Promise<string[]> {
      return (await db.select({ key: projects.key }).from(projects)
        .where(and(isNull(projects.paperTitle), isNotNull(projects.paperPath))))
        .map((row) => row.key);
    },

    async setReviewThread(projectKey: string, threadId: string): Promise<void> {
      await db
        .update(projects)
        .set({ reviewThreadId: threadId, updatedAt: new Date() })
        .where(eq(projects.key, projectKey));
    },

    async clearReviewThreads(): Promise<void> {
      await db.update(projects).set({ reviewThreadId: null });
    },

    async remove(input: { projectKey: string; confirmTitle: string }): Promise<DeleteProjectResult> {
      const project = await getRow(input.projectKey);
      if (normalizeTitle(input.confirmTitle) !== normalizeTitle(project.title)) {
        throw new UserError("confirmTitle does not match the project title");
      }
      await db.delete(projects).where(eq(projects.id, project.id));
      // The paper's text copy may still be landing in paper/ right after an upload.
      await fsp.rm(dir(project.key), { recursive: true, force: true, maxRetries: 5 });
      return { deleted: true, projectKey: project.key, title: project.title };
    },

    async source(input: ProjectSourceInput): Promise<unknown> {
      const root = dir((await getRow(input.projectKey)).key);
      const relativePath = input.path ?? "";
      const depth = input.depth ?? 4;
      if (input.action === "read") return files.readText(root, relativePath, input.offset ?? 0);
      if (input.action === "tree") return { path: relativePath, entries: await files.tree(root, relativePath, depth) };
      if (!input.query) throw new UserError("search requires query");
      return {
        query: input.query,
        results: await files.searchText(root, relativePath, input.query, depth, input.limit ?? 20),
      };
    },

    async tree(projectKey: string, relativePath: string, depth: number) {
      return { path: relativePath, entries: await files.tree(dir((await getRow(projectKey)).key), relativePath, depth) };
    },

    async readText(projectKey: string, relativePath: string, offset: number) {
      return files.readText(dir((await getRow(projectKey)).key), relativePath, offset);
    },

    async readMedia(projectKey: string, relativePath: string) {
      return files.readMedia(dir((await getRow(projectKey)).key), relativePath);
    },
  };
}
