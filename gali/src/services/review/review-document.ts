import fsp from "node:fs/promises";
import path from "node:path";
import {
  REVIEW_FILE,
  REVIEW_SEVERITIES,
  USER_NOTES_FILE,
  type ReviewDismissal,
  type ReviewDocument,
  type ReviewDto,
  type ReviewFinding,
  type ReviewPaperAnchor,
  type ReviewRef,
  type ReviewSeverity,
  type ReviewVisual,
} from "../../../shared/domain/contracts.js";
import { UserError } from "../../lib/user-error.js";
import type { PdfAnnotations } from "../projects/pdf-annotations.js";
import type { ProjectService } from "../projects/project-service.js";

const MAX_REVIEW_BYTES = 512 * 1024;
const MAX_FINDINGS = 40;
const MAX_REFS = 8;
const MAX_VISUALS = 4;
const MAX_TEXT = 4000;
const MAX_SERIES = 6;
const MAX_POINTS = 500;
const MAX_TABLE_ROWS = 60;
const MAX_TABLE_COLUMNS = 12;
const MAX_CODE_BYTES = 5 * 1024 * 1024;
const FIGURE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

type Parsed = { document: ReviewDocument | null; problems: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function parseRef(raw: unknown, where: string, problems: string[]): ReviewRef | null {
  if (isRecord(raw) && isRecord(raw.paper)) {
    const page = positiveInt(raw.paper.page);
    const quote = text(raw.paper.quote, 600);
    const place = text(raw.paper.place, 60);
    if (raw.paper.place !== undefined && place === null) {
      problems.push(`${where}: place is a short name from the paper, like "§3.2 Clustering" or "Table 2" (at most 60 characters)`);
    }
    if (page !== null && quote !== null) return { paper: { page, quote, ...(place !== null ? { place } : {}) } };
    problems.push(`${where}: a paper ref needs page (a number from 1) and quote (exact text from that page)`);
    return null;
  }
  if (isRecord(raw) && isRecord(raw.code)) {
    const file = text(raw.code.path, 400);
    const lines = raw.code.lines;
    const start = Array.isArray(lines) ? positiveInt(lines[0]) : null;
    const end = Array.isArray(lines) ? positiveInt(lines[1] ?? lines[0]) : null;
    if (file !== null && start !== null && end !== null && end >= start) {
      return { code: { path: file.replaceAll("\\", "/").replace(/^\.\//, ""), lines: [start, end] } };
    }
    problems.push(`${where}: a code ref needs path and lines [first, last]`);
    return null;
  }
  problems.push(`${where}: a ref is either {"paper": …} or {"code": …}`);
  return null;
}

export function parseVisual(raw: unknown, where: string, problems: string[]): ReviewVisual | null {
  if (isRecord(raw) && isRecord(raw.figure)) {
    const file = text(raw.figure.path, 400);
    const caption = text(raw.figure.caption, 400);
    if (file !== null && caption !== null) {
      return { figure: { path: file.replaceAll("\\", "/").replace(/^\.\//, ""), caption } };
    }
    problems.push(`${where}: a figure needs path and caption`);
    return null;
  }
  if (isRecord(raw) && isRecord(raw.chart)) {
    const chart = raw.chart;
    const kind = chart.kind === "line" || chart.kind === "bar" ? chart.kind : null;
    const caption = text(chart.caption, 400);
    const x = isRecord(chart.x) ? chart.x : null;
    const xLabel = x ? text(x.label, 80) : null;
    const xValues = x && Array.isArray(x.values) && x.values.length > 0 && x.values.length <= MAX_POINTS
      && x.values.every((value) => typeof value === "number" || typeof value === "string")
      ? (x.values as Array<number | string>)
      : null;
    const series = Array.isArray(chart.series) && chart.series.length > 0 && chart.series.length <= MAX_SERIES
      ? chart.series.map((item) => {
        if (!isRecord(item)) return null;
        const name = text(item.name, 80);
        const values = Array.isArray(item.values)
          && item.values.length === xValues?.length
          && item.values.every((value) => typeof value === "number" && Number.isFinite(value))
          ? (item.values as number[])
          : null;
        return name !== null && values !== null ? { name, values } : null;
      })
      : null;
    if (kind && caption !== null && xLabel !== null && xValues && series && series.every((item) => item !== null)) {
      return { chart: { kind, caption, x: { label: xLabel, values: xValues }, series } };
    }
    problems.push(
      `${where}: a chart needs kind (line or bar), caption, x {label, values}, and 1–${MAX_SERIES} series {name, values} with one number per x value`,
    );
    return null;
  }
  if (isRecord(raw) && isRecord(raw.table)) {
    const table = raw.table;
    const caption = text(table.caption, 400);
    const columns = Array.isArray(table.columns) && table.columns.length > 0 && table.columns.length <= MAX_TABLE_COLUMNS
      && table.columns.every((column) => typeof column === "string")
      ? (table.columns as string[])
      : null;
    const rows = Array.isArray(table.rows) && table.rows.length <= MAX_TABLE_ROWS
      && table.rows.every((row) =>
        Array.isArray(row) && row.length === columns?.length
        && row.every((cell) => typeof cell === "string" || (typeof cell === "number" && Number.isFinite(cell)))
      )
      ? (table.rows as Array<Array<string | number>>).map((row) => row.map(String))
      : null;
    if (caption !== null && columns && rows) return { table: { caption, columns, rows } };
    problems.push(`${where}: a table needs caption, columns (strings), and rows (one string or number per column)`);
    return null;
  }
  problems.push(`${where}: a visual is {"figure": …}, {"chart": …}, or {"table": …}`);
  return null;
}

function parseFinding(raw: unknown, index: number, seen: Set<string>, problems: string[]): ReviewFinding | null {
  const where = `finding ${index + 1}`;
  if (!isRecord(raw)) {
    problems.push(`${where} is not an object`);
    return null;
  }
  const id = text(raw.id, 40);
  const severity = REVIEW_SEVERITIES.includes(raw.severity as ReviewSeverity) ? (raw.severity as ReviewSeverity) : null;
  const title = text(raw.title, 200);
  const body = text(raw.body);
  if (id === null || severity === null || title === null || body === null) {
    problems.push(`${where} needs id, severity (${REVIEW_SEVERITIES.join(", ")}), title, and body`);
    return null;
  }
  if (seen.has(id)) {
    problems.push(`${where}: id "${id}" is used twice`);
    return null;
  }
  seen.add(id);
  const refsRaw = raw.refs ?? [];
  const visualsRaw = raw.visuals ?? [];
  if (!Array.isArray(refsRaw) || refsRaw.length > MAX_REFS) problems.push(`${id}: refs must be a list of at most ${MAX_REFS}`);
  if (!Array.isArray(visualsRaw) || visualsRaw.length > MAX_VISUALS) {
    problems.push(`${id}: visuals must be a list of at most ${MAX_VISUALS}`);
  }
  const refs = Array.isArray(refsRaw)
    ? refsRaw.slice(0, MAX_REFS).map((ref, refIndex) => parseRef(ref, `${id} ref ${refIndex + 1}`, problems))
    : [];
  const visuals = Array.isArray(visualsRaw)
    ? visualsRaw.slice(0, MAX_VISUALS).map((visual, visualIndex) =>
      parseVisual(visual, `${id} visual ${visualIndex + 1}`, problems)
    )
    : [];
  return {
    id,
    severity,
    title,
    body,
    refs: refs.filter((ref): ref is ReviewRef => ref !== null),
    visuals: visuals.filter((visual): visual is ReviewVisual => visual !== null),
  };
}

/** Keeps every well-formed part and names each malformed one, so one bad ref does not hide the review. */
export function parseReviewDocument(raw: unknown): Parsed {
  const problems: string[] = [];
  if (!isRecord(raw)) return { document: null, problems: [`${REVIEW_FILE} must be a JSON object`] };
  const title = text(raw.title, 200);
  if (title === null) return { document: null, problems: [`${REVIEW_FILE} needs a title`] };
  const findingsRaw = raw.findings ?? [];
  if (!Array.isArray(findingsRaw)) return { document: null, problems: ["findings must be a list"] };
  if (findingsRaw.length > MAX_FINDINGS) problems.push(`at most ${MAX_FINDINGS} findings; the rest are not shown`);
  const seen = new Set<string>();
  const findings = findingsRaw
    .slice(0, MAX_FINDINGS)
    .map((finding, index) => parseFinding(finding, index, seen, problems))
    .filter((finding): finding is ReviewFinding => finding !== null);
  return { document: { title, findings }, problems };
}

export function insideProject(root: string, relative: string): string | null {
  const absolute = path.resolve(root, relative);
  const rel = path.relative(root, absolute);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? absolute : null;
}

async function lineCount(file: string): Promise<number | null> {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size > MAX_CODE_BYTES) return Number.POSITIVE_INFINITY;
  const content = await fsp.readFile(file, "utf8");
  return content === "" ? 0 : content.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(content) ? 1 : 0);
}

export function renderUserNotes(dismissed: readonly ReviewDismissal[]): string {
  return [
    "# Notes from the human",
    "",
    "The app writes this file from what the human does in the Review panel. Do not edit it.",
    "",
    "## Dismissed findings",
    "",
    `The human read these findings and dismissed them as not important. Do not raise them again, under any id or wording, unless the human asks. Leave them in ${REVIEW_FILE}; the app hides them.`,
    "",
    ...dismissed.map((item) => `- ${item.id} · ${item.title}: ${item.body} (dismissed ${item.dismissedAt.slice(0, 10)})`),
    "",
  ].join("\n");
}

type CheckedReview = Omit<ReviewDto, "dismissed">;

export type ReviewDocuments = ReturnType<typeof createReviewDocuments>;

/**
 * Reads the reviewer's review.json and checks it against the project: every paper quote is
 * located (that location is what a click flashes), every code range and figure exists. The
 * result is cached on the file's mtime because locating quotes opens the PDF.
 */
export function createReviewDocuments(opts: {
  projects: ProjectService;
  pdfAnnotations: PdfAnnotations;
  snapshotsRoot: string;
  dismissalsRoot: string;
}) {
  const cache = new Map<string, { mtimeMs: number; dto: CheckedReview }>();
  const reviewPath = (projectKey: string) => path.join(opts.projects.dir(projectKey), REVIEW_FILE);
  const snapshotPath = (projectKey: string) => path.join(opts.snapshotsRoot, `${projectKey}.json`);
  const dismissalsPath = (projectKey: string) => path.join(opts.dismissalsRoot, `${projectKey}.json`);

  async function dismissals(projectKey: string): Promise<ReviewDismissal[]> {
    const raw = await fsp.readFile(dismissalsPath(projectKey), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return raw === null ? [] : (JSON.parse(raw) as ReviewDismissal[]);
  }

  /** The list lives outside the project folder; USER_NOTES.md is its copy for the reviewer. */
  async function saveDismissals(projectKey: string, items: ReviewDismissal[]) {
    await fsp.mkdir(opts.dismissalsRoot, { recursive: true });
    await fsp.writeFile(dismissalsPath(projectKey), JSON.stringify(items, null, 2));
    const notesPath = path.join(opts.projects.dir(projectKey), USER_NOTES_FILE);
    if (items.length === 0) await fsp.rm(notesPath, { force: true });
    else await fsp.writeFile(notesPath, renderUserNotes(items));
  }

  async function stamp(projectKey: string): Promise<number | null> {
    const stat = await fsp.stat(reviewPath(projectKey)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return stat ? stat.mtimeMs : null;
  }

  async function check(projectKey: string, document: ReviewDocument, problems: string[]) {
    const project = await opts.projects.getRow(projectKey);
    const root = opts.projects.dir(projectKey);
    const anchors: Record<string, ReviewPaperAnchor | null> = {};
    const paperRefs: Array<{ key: string; label: string; quote: string; page: number }> = [];

    for (const finding of document.findings) {
      for (const [index, ref] of finding.refs.entries()) {
        const label = `${finding.id} ref ${index + 1}`;
        if ("paper" in ref) {
          paperRefs.push({ key: `${finding.id}:${index}`, label, ...ref.paper });
          continue;
        }
        const file = insideProject(root, ref.code.path);
        const count = file ? await lineCount(file) : null;
        if (count === null) problems.push(`${label}: ${ref.code.path} is not a file in the project`);
        else if (ref.code.lines[1] > count) {
          problems.push(`${label}: ${ref.code.path} has ${count} lines, not ${ref.code.lines[1]}`);
        }
      }
      for (const [index, visual] of finding.visuals.entries()) {
        if (!("figure" in visual)) continue;
        const label = `${finding.id} visual ${index + 1}`;
        const file = insideProject(root, visual.figure.path);
        const ext = path.extname(visual.figure.path).toLowerCase();
        if (!FIGURE_EXTENSIONS.has(ext)) {
          problems.push(`${label}: figures must be ${[...FIGURE_EXTENSIONS].join(", ")}`);
        } else if (!file || !(await fsp.stat(file).catch(() => null))?.isFile()) {
          problems.push(`${label}: ${visual.figure.path} is not a file in the project`);
        }
      }
    }

    if (project.paperPath === null) {
      for (const ref of paperRefs) problems.push(`${ref.label}: this project has no PDF, so a finding cannot cite a page`);
      return anchors;
    }
    const located = await opts.pdfAnnotations.locateMany(projectKey, project.paperPath, paperRefs);
    for (const [index, ref] of paperRefs.entries()) {
      const hit = located[index] ?? null;
      anchors[ref.key] = hit;
      if (!hit) problems.push(`${ref.label}: the quote is not in the paper; copy it exactly from the text copy`);
      else if (hit.page !== ref.page) problems.push(`${ref.label}: the quote is on page ${hit.page}, not page ${ref.page}`);
    }
    return anchors;
  }

  async function read(projectKey: string): Promise<ReviewDto | null> {
    const checked = await readChecked(projectKey);
    return checked ? { ...checked, dismissed: await dismissals(projectKey) } : null;
  }

  async function readChecked(projectKey: string): Promise<CheckedReview | null> {
    const mtimeMs = await stamp(projectKey);
    if (mtimeMs === null) {
      cache.delete(projectKey);
      return null;
    }
    const cached = cache.get(projectKey);
    if (cached?.mtimeMs === mtimeMs) return cached.dto;

    const updatedAt = new Date(mtimeMs).toISOString();
    const file = reviewPath(projectKey);
    const size = (await fsp.stat(file)).size;
    let dto: CheckedReview;
    if (size > MAX_REVIEW_BYTES) {
      dto = { document: null, updatedAt, problems: [`${REVIEW_FILE} is larger than ${MAX_REVIEW_BYTES / 1024} KB`], anchors: {} };
    } else {
      let raw: unknown;
      let parseError: string | null = null;
      try {
        raw = JSON.parse(await fsp.readFile(file, "utf8"));
      } catch (error) {
        parseError = `${REVIEW_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (parseError !== null) {
        dto = { document: null, updatedAt, problems: [parseError], anchors: {} };
      } else {
        const parsed = parseReviewDocument(raw);
        const anchors = parsed.document ? await check(projectKey, parsed.document, parsed.problems) : {};
        dto = { document: parsed.document, updatedAt, problems: parsed.problems, anchors };
      }
    }
    cache.set(projectKey, { mtimeMs, dto });
    return dto;
  }

  async function acceptedIds(projectKey: string): Promise<string[]> {
    const raw = await fsp.readFile(snapshotPath(projectKey), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return raw === null ? [] : (JSON.parse(raw) as string[]);
  }

  return {
    stamp,
    read,
    dismissals,

    async dismiss(projectKey: string, findingId: string): Promise<ReviewDto> {
      const dto = await read(projectKey);
      const finding = dto?.document?.findings.find((item) => item.id === findingId);
      if (!dto || !finding) throw new UserError(`no finding ${findingId} in the review`);
      if (!dto.dismissed.some((item) => item.id === findingId)) {
        await saveDismissals(projectKey, [
          ...dto.dismissed,
          { id: finding.id, title: finding.title, body: finding.body, dismissedAt: new Date().toISOString() },
        ]);
      }
      return (await read(projectKey))!;
    },

    async restore(projectKey: string, findingId: string): Promise<ReviewDto | null> {
      const current = await dismissals(projectKey);
      const next = current.filter((item) => item.id !== findingId);
      if (next.length === current.length) throw new UserError(`finding ${findingId} is not dismissed`);
      await saveDismissals(projectKey, next);
      return read(projectKey);
    },

    /** What the reviewer must fix: the user-visible problems, plus findings that vanished since the last accepted turn. */
    async audit(projectKey: string): Promise<string[]> {
      const dto = await read(projectKey);
      if (!dto) return [];
      const problems = [...dto.problems];
      if (dto.document) {
        const now = new Set([...dto.document.findings.map((finding) => finding.id), ...dto.dismissed.map((item) => item.id)]);
        const gone = (await acceptedIds(projectKey)).filter((id) => !now.has(id));
        if (gone.length > 0) {
          problems.push(`finding${gone.length > 1 ? "s" : ""} ${gone.join(", ")} disappeared; restore unless the user asked to remove them`);
        }
      }
      return problems;
    },

    /** The snapshot lives outside the project folder, where the reviewer cannot edit it. */
    async accept(projectKey: string): Promise<void> {
      const dto = await read(projectKey);
      if (!dto?.document) return;
      await fsp.mkdir(opts.snapshotsRoot, { recursive: true });
      await fsp.writeFile(snapshotPath(projectKey), JSON.stringify(dto.document.findings.map((finding) => finding.id)));
    },

    async forget(projectKey: string): Promise<void> {
      cache.delete(projectKey);
      await fsp.rm(snapshotPath(projectKey), { force: true });
      await fsp.rm(dismissalsPath(projectKey), { force: true });
    },
  };
}
