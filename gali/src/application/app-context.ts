import fsp from "node:fs/promises";
import path from "node:path";
import { GALI_CONFIG } from "../../shared/config.js";
import { REVIEW_FILE, type ProjectEvent, type ReviewProgressEvent, type ReviewerEvent } from "../../shared/domain/contracts.js";
import { UserError } from "../lib/user-error.js";
import type { AgentProvider } from "../agents/core/types.js";
import { createProjectFiles } from "../adapters/fs/project-files.js";
import { extractPaperTitle } from "../adapters/openai/paper-title.js";
import { reviewProgressLine } from "../adapters/openai/review-progress-line.js";
import { codexCredentialsFromEnv, createCodexProvider } from "../agents/providers/codex/codex-provider.js";
import { createDb } from "../db/client.js";
import { createImportUploadService } from "../services/projects/import-upload-service.js";
import { createPdfAnnotations } from "../services/projects/pdf-annotations.js";
import { createProjectChat } from "../services/projects/project-chat.js";
import { ensurePdfCache, syncPdfShadows } from "../services/projects/pdf-cache.js";
import { createProjectService } from "../services/projects/project-service.js";
import { createReviewDocuments } from "../services/review/review-document.js";
import { createReviewProgress } from "../services/review/review-progress.js";
import { createReviewService } from "../services/review/review-service.js";
export type AppContext = Awaited<ReturnType<typeof createAppContext>>;

const FIRST_PAGE_CHARS = 6000;

/**
 * Paper review lives in its own folders, so data from the research product on
 * an older disk stays where it is and is simply not shown.
 */
export async function createAppContext(opts: {
  dataDir: string;
  migrations: string;
  onReviewerEvent: (event: ReviewerEvent) => void;
  onProjectEvent: (event: ProjectEvent) => void;
  onReviewProgress: (event: ReviewProgressEvent) => void;
  provider?: AgentProvider;
  extractPaperTitle?: (firstPage: string) => Promise<string | null>;
  reviewProgressLine?: (input: { previous: string | null; actions: string[] }) => Promise<string>;
}) {
  const { db, client } = await createDb(path.join(opts.dataDir, "review-db"), opts.migrations);
  const files = createProjectFiles();
  const pdfCacheRoot = path.join(opts.dataDir, "pdf-cache");
  const projects = createProjectService({ db, files, projectsRoot: path.join(opts.dataDir, "papers") });

  const paperPdf = async (projectKey: string) => {
    const { paperPath } = await projects.getRow(projectKey);
    if (paperPath === null) throw new UserError("this project has no PDF");
    return path.join(projects.dir(projectKey), paperPath);
  };
  const paperText = async (projectKey: string): Promise<string> => {
    const cached = await ensurePdfCache(pdfCacheRoot, await paperPdf(projectKey));
    return fsp.readFile(cached.textPath, "utf8");
  };

  const pdfAnnotations = createPdfAnnotations({
    dataDir: opts.dataDir,
    readPdf: async (projectKey, pdfPath) => (await projects.readMedia(projectKey, pdfPath)).data,
  });

  const projectChat = createProjectChat(opts.dataDir);

  const reviewDocuments = createReviewDocuments({
    projects,
    pdfAnnotations,
    snapshotsRoot: path.join(opts.dataDir, "review-snapshots"),
    dismissalsRoot: path.join(opts.dataDir, "review-dismissals"),
  });

  // A thread keeps the instructions it started with, so threads from the old research mode start over once.
  const researchModeFlag = path.join(opts.dataDir, "research-mode");
  if (await fsp.stat(researchModeFlag).catch(() => null)) {
    await projects.clearReviewThreads();
    await fsp.rm(researchModeFlag, { force: true });
  }

  const review = createReviewService({
    provider: opts.provider ?? createCodexProvider(codexCredentialsFromEnv(process.env, GALI_CONFIG.codexModel)),
    projects,
    codexHomeRoot: path.join(opts.dataDir, "codex-reviewer"),
    pdfCacheRoot,
    turnMinutes: GALI_CONFIG.reviewTurnMinutes,
    subagentMinutes: GALI_CONFIG.reviewSubagentMinutes,
    idleMinutes: GALI_CONFIG.reviewerIdleMinutes,
    documents: {
      stamp: async (projectKey) => `${await reviewDocuments.stamp(projectKey) ?? "-"}`,
      audit: async (projectKey) =>
        (await reviewDocuments.audit(projectKey)).map((problem) => `${REVIEW_FILE}: ${problem}`),
      accept: reviewDocuments.accept,
      dismissals: reviewDocuments.dismissals,
    },
    progress: createReviewProgress({
      tickMs: GALI_CONFIG.reviewProgressSeconds * 1000,
      describe: opts.reviewProgressLine ?? reviewProgressLine,
      emit: opts.onReviewProgress,
    }),
    emit: (event) => {
      opts.onReviewerEvent(event);
      // The reviewer may have written the review or scratch files.
      if (event.type === "reviewer.finished") {
        opts.onProjectEvent({ projectKey: event.projectKey, type: "project.changed" });
      }
    },
    onReviewRepaired: (projectKey) => opts.onProjectEvent({ projectKey, type: "project.changed" }),
  });

  const extractTitle = opts.extractPaperTitle ?? extractPaperTitle;
  const titling = new Map<string, Promise<void>>();

  function titlePaper(projectKey: string): Promise<void> {
    const running = titling.get(projectKey);
    if (running) return running;
    const job = (async () => {
      const text = await paperText(projectKey);
      const firstPage = text.split(/^=== page \d+.*===$/m)[1]?.trim().slice(0, FIRST_PAGE_CHARS);
      if (!firstPage) return;
      const title = await extractTitle(firstPage);
      if (!title) return;
      await projects.setPaperTitle(projectKey, title);
      await projects.adoptPaperTitle(projectKey);
      opts.onProjectEvent({ projectKey, type: "project.changed" });
    })()
      .catch((error: unknown) => {
        console.warn(`[paper-title] ${projectKey}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => titling.delete(projectKey));
    titling.set(projectKey, job);
    return job;
  }

  const shadowPdfs = (projectKey: string) =>
    syncPdfShadows(pdfCacheRoot, projects.dir(projectKey)).catch((error: unknown) => {
      console.warn(`[pdf-shadow] ${projectKey}: ${error instanceof Error ? error.message : String(error)}`);
    });

  const importUpload = createImportUploadService(opts.dataDir, async (input) => {
    const project = await projects.createFromUpload(input);
    // Writes paper/<file>.pdf.txt beside the PDF and warms the page images, so the first question does not wait.
    void shadowPdfs(project.key).then(() => {
      if (project.paperPath !== null) return titlePaper(project.key);
    });
    return project;
  });

  // Both queries run before the slow PDF work, so it never touches a database closed meanwhile.
  const keys = (await projects.list()).map((project) => project.key);
  const untitled = await projects.untitledPapers();
  for (const key of keys) await projects.adoptPaperTitle(key);
  void (async () => {
    for (const key of keys) await shadowPdfs(key);
    for (const key of untitled) await titlePaper(key);
  })();

  return {
    db,
    client,
    dataDir: opts.dataDir,
    projects,
    pdfAnnotations,
    projectChat,
    review,
    reviewDocuments,
    importUpload,
    titlePaper,

    /** Plain text of the paper with "=== page N ===" markers. */
    paperText,

    async renameProject(projectKey: string, title: string) {
      const project = await projects.rename(projectKey, title);
      opts.onProjectEvent({ projectKey, type: "project.changed" });
      return project;
    },

    async deleteProject(input: { projectKey: string; confirmTitle: string }) {
      const result = await projects.remove(input);
      await review.forget(result.projectKey);
      await pdfAnnotations.forget(result.projectKey);
      await projectChat.forget(result.projectKey);
      await reviewDocuments.forget(result.projectKey);
      return result;
    },

    async visibleProjects() {
      return (await projects.list()).filter((project) => project.paperPath !== null);
    },
  };
}
