import fsp from "node:fs/promises";
import path from "node:path";
import {
  PDF_ANNOTATION_RGB,
  pdfAnnotationLabel,
  type PdfAnnotationColor,
  type PdfAnnotationDto,
  type PdfAnnotationExportFormat,
  type PdfRect,
} from "../../../shared/domain/contracts.js";
import { pdfShadowPath } from "../../lib/pdf-shadow.js";
import { UserError } from "../../lib/user-error.js";
import { withPdfDocument } from "./pdfium.js";

// An elided quote ("we compare … baseline") must close within this many characters.
const ELISION_SPAN = 2000;
const EXPORT_AUTHOR = "Gali";
const NOTE_ICON = 18;

const FOLD: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\u2018": "'",
  "\u2019": "'",
  "\u201C": "\"",
  "\u201D": "\"",
  "\u2010": "-",
  "\u2011": "-",
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
  "\u00AD": "",
  "\uFFFE": "",
  "\u0002": "",
};

type Normalized = { value: string; index: number[] };

/** Lowercased, folded, whitespace-collapsed, with each output char mapped to its source char. */
function normalize(text: string): Normalized {
  let value = "";
  const index: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "-" && /\p{L}/u.test(text[i - 1] ?? "")) {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j += 1;
      if (/[\r\n]/.test(text.slice(i + 1, j)) && /\p{L}/u.test(text[j] ?? "")) {
        i = j - 1;
        continue;
      }
    }
    if (/\s/.test(ch)) {
      if (value.length > 0 && !value.endsWith(" ")) {
        value += " ";
        index.push(i);
      }
      continue;
    }
    for (const folded of (FOLD[ch] ?? ch).toLowerCase()) {
      value += folded;
      index.push(i);
    }
  }
  return { value, index };
}

function quoteParts(quote: string): string[] {
  return quote
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((part) => normalize(part.replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, "")).value.trim())
    .filter((part) => part.length > 0);
}

/** Normalized [start, end) of every occurrence of the quote's parts, in order. */
function findAll(haystack: string, parts: string[]): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const start = haystack.indexOf(parts[0]!, from);
    if (start < 0) return found;
    let end = start + parts[0]!.length;
    let complete = true;
    for (const part of parts.slice(1)) {
      const next = haystack.indexOf(part, end);
      if (next < 0 || next - start > ELISION_SPAN) {
        complete = false;
        break;
      }
      end = next + part.length;
    }
    if (complete) found.push([start, end]);
    from = start + 1;
  }
}

/** PDFium splits a line wherever the font changes; one box per line reads as one highlight. */
function mergeLines(rects: PdfRect[]): PdfRect[] {
  const lines: PdfRect[] = [];
  for (const rect of rects) {
    const center = rect.y + rect.height / 2;
    const line = lines.find((other) =>
      Math.abs(other.y + other.height / 2 - center) < Math.max(other.height, rect.height) / 2
    );
    if (!line) {
      lines.push({ ...rect });
      continue;
    }
    const right = Math.max(line.x + line.width, rect.x + rect.width);
    const bottom = Math.max(line.y + line.height, rect.y + rect.height);
    line.x = Math.min(line.x, rect.x);
    line.y = Math.min(line.y, rect.y);
    line.width = right - line.x;
    line.height = bottom - line.y;
  }
  return lines;
}

type Located = {
  page: number;
  pageWidth: number;
  pageHeight: number;
  rects: PdfRect[];
  matches: number;
};

/** The first match, searching `preferredPage` first, plus how many matches the whole PDF has. */
function locateQuote(bytes: Uint8Array, quote: string, preferredPage?: number): Promise<Located | null> {
  const parts = quoteParts(quote);
  if (parts.length === 0) throw new UserError("quote must contain text");
  return withPdfDocument(bytes, (doc) => {
    const order = Array.from({ length: doc.pageCount }, (_, index) => index + 1);
    if (preferredPage !== undefined && preferredPage >= 1 && preferredPage <= doc.pageCount) {
      order.splice(order.indexOf(preferredPage), 1);
      order.unshift(preferredPage);
    }
    let first: Omit<Located, "matches"> | null = null;
    let matches = 0;
    for (const number of order) {
      const hit = doc.page(number, (page) => {
        const text = normalize(page.text());
        const found = findAll(text.value, parts);
        matches += found.length;
        if (first || found.length === 0) return null;
        const [start, end] = found[0]!;
        const from = text.index[start]!;
        const to = text.index[end - 1]!;
        return {
          page: number,
          pageWidth: page.width,
          pageHeight: page.height,
          rects: mergeLines(page.textRects(from, to - from + 1)),
        };
      });
      first ??= hit;
    }
    return first ? { ...first, matches } : null;
  });
}

function pageSize(bytes: Uint8Array, number: number): Promise<{ pageWidth: number; pageHeight: number }> {
  return withPdfDocument(bytes, (doc) =>
    doc.page(number, (page) => ({ pageWidth: page.width, pageHeight: page.height }))
  );
}

function writeAnnotatedPdf(bytes: Uint8Array, items: readonly PdfAnnotationDto[]): Promise<Uint8Array> {
  return withPdfDocument(bytes, (doc) => {
    for (const item of items) {
      doc.page(item.page, (page) => {
        const common = { rgb: PDF_ANNOTATION_RGB[item.color], author: EXPORT_AUTHOR, contents: pdfAnnotationLabel(item) };
        if (item.rects.length > 0) {
          page.addHighlight({ ...common, rects: item.rects });
        } else {
          page.addNote({
            ...common,
            rect: { x: page.width - 2 * NOTE_ICON, y: NOTE_ICON, width: NOTE_ICON, height: NOTE_ICON },
          });
        }
      });
    }
    return doc.save();
  });
}

function readingOrder(items: readonly PdfAnnotationDto[]): PdfAnnotationDto[] {
  return [...items].sort((a, b) => a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0));
}

/**
 * One heading per annotation, saying what it is: a highlight's passage is a blockquote with its
 * note labelled under it; a page note is plain text. Numbers match the viewer pins and PDF comments.
 */
function notesMarkdown(pdfPath: string, items: readonly PdfAnnotationDto[]): string {
  const blocks = [`# Notes on ${path.posix.basename(pdfPath)}`];
  let page = 0;
  for (const item of readingOrder(items)) {
    if (item.page !== page) {
      page = item.page;
      blocks.push(`## Page ${page}`);
    }
    if (item.quote === null) {
      blocks.push(`### ${item.number} · Note`, item.note ?? "");
      continue;
    }
    // A quote's line breaks come from the paper's layout; a note's are the user's own.
    blocks.push(`### ${item.number} · Highlight`, `> ${item.quote.replace(/\s+/g, " ")}`);
    if (item.note) blocks.push(`**Note:** ${item.note}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

export type PdfAnnotationExport = { data: Uint8Array; filename: string; contentType: string };

type FileAnnotations = { next: number; items: PdfAnnotationDto[] };
type ProjectAnnotations = { files: Record<string, FileAnnotations> };

export type PdfAnnotationsDeps = {
  dataDir: string;
  readPdf: (projectKey: string, pdfPath: string) => Promise<Uint8Array>;
};

/**
 * Highlights and notes on board PDFs, kept per project on the data disk,
 * outside the project repo. Numbers are per PDF and never reused.
 */
export function createPdfAnnotations(deps: PdfAnnotationsDeps) {
  const root = path.join(deps.dataDir, "pdf-annotations");
  const queues = new Map<string, Promise<unknown>>();

  const fileFor = (projectKey: string) => path.join(root, `${projectKey}.json`);

  async function read(projectKey: string): Promise<ProjectAnnotations> {
    let raw: string;
    try {
      raw = await fsp.readFile(fileFor(projectKey), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: {} };
      throw error;
    }
    return JSON.parse(raw) as ProjectAnnotations;
  }

  async function write(projectKey: string, state: ProjectAnnotations): Promise<void> {
    await fsp.mkdir(root, { recursive: true });
    const target = fileFor(projectKey);
    const staging = `${target}.tmp`;
    await fsp.writeFile(staging, JSON.stringify(state));
    await fsp.rename(staging, target);
  }

  function exclusive<T>(projectKey: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(projectKey) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    queues.set(projectKey, next.catch(() => undefined));
    return next;
  }

  function update<T>(
    projectKey: string,
    pdfPath: string,
    change: (file: FileAnnotations) => T,
  ): Promise<T> {
    return exclusive(projectKey, async () => {
      const state = await read(projectKey);
      const file = state.files[pdfPath] ?? { next: 1, items: [] };
      const result = change(file);
      state.files[pdfPath] = file;
      await write(projectKey, state);
      return result;
    });
  }

  function find(file: FileAnnotations | undefined, pdfPath: string, number: number): PdfAnnotationDto {
    const item = file?.items.find((entry) => entry.number === number);
    if (!item) {
      const known = file?.items.map((entry) => entry.number).join(", ") || "none";
      throw new UserError(`no annotation ${number} on ${pdfPath}; existing: ${known}`);
    }
    return item;
  }

  function assertPdf(pdfPath: string) {
    if (!pdfPath.toLowerCase().endsWith(".pdf")) throw new UserError(`${pdfPath} is not a PDF`);
  }

  async function locate(projectKey: string, pdfPath: string, quote: string, page?: number) {
    const located = await locateQuote(await deps.readPdf(projectKey, pdfPath), quote, page);
    if (!located || located.rects.length === 0) {
      throw new UserError(
        `quote not found in ${pdfPath}. Read the page text (project_source read ${pdfShadowPath(pdfPath)}, or search for a few words) and pass a verbatim passage; use … to skip the middle of a long one.`,
      );
    }
    return located;
  }

  function append(
    file: FileAnnotations,
    item: Omit<PdfAnnotationDto, "number" | "createdAt">,
  ): PdfAnnotationDto {
    const created = { ...item, number: file.next, createdAt: new Date().toISOString() };
    file.next += 1;
    file.items.push(created);
    return created;
  }

  return {
    /** Every quote located in one pass over the PDF; null where a quote is not found. */
    async locateMany(
      projectKey: string,
      pdfPath: string,
      queries: ReadonlyArray<{ quote: string; page: number }>,
    ): Promise<Array<Omit<Located, "matches"> | null>> {
      if (queries.length === 0) return [];
      return withPdfDocument(await deps.readPdf(projectKey, pdfPath), (doc) => {
        const texts = new Map<number, Normalized>();
        return queries.map(({ quote, page }) => {
          const parts = quoteParts(quote);
          if (parts.length === 0) return null;
          const order = Array.from({ length: doc.pageCount }, (_, index) => index + 1);
          if (page >= 1 && page <= doc.pageCount) {
            order.splice(order.indexOf(page), 1);
            order.unshift(page);
          }
          for (const number of order) {
            const hit = doc.page(number, (pdfPage) => {
              let text = texts.get(number);
              if (!text) {
                text = normalize(pdfPage.text());
                texts.set(number, text);
              }
              const found = findAll(text.value, parts);
              if (found.length === 0) return null;
              const [start, end] = found[0]!;
              const from = text.index[start]!;
              const to = text.index[end - 1]!;
              return {
                page: number,
                pageWidth: pdfPage.width,
                pageHeight: pdfPage.height,
                rects: mergeLines(pdfPage.textRects(from, to - from + 1)),
              };
            });
            if (hit && hit.rects.length > 0) return hit;
          }
          return null;
        });
      });
    },

    async list(projectKey: string, pdfPath?: string): Promise<Array<PdfAnnotationDto & { path: string }>> {
      const state = await read(projectKey);
      return Object.entries(state.files)
        .filter(([filePath]) => pdfPath === undefined || filePath === pdfPath)
        .flatMap(([filePath, file]) => readingOrder(file.items).map((item) => ({ ...item, path: filePath })));
    },

    async get(projectKey: string, pdfPath: string, number: number): Promise<PdfAnnotationDto> {
      return find((await read(projectKey)).files[pdfPath], pdfPath, number);
    },

    async highlight(input: {
      projectKey: string;
      path: string;
      quote: string;
      page?: number;
      color?: PdfAnnotationColor;
      note?: string;
      findingId?: string;
    }): Promise<{ annotation: PdfAnnotationDto; matches: number }> {
      assertPdf(input.path);
      const located = await locate(input.projectKey, input.path, input.quote, input.page);
      const annotation = await update(input.projectKey, input.path, (file) =>
        append(file, {
          page: located.page,
          pageWidth: located.pageWidth,
          pageHeight: located.pageHeight,
          rects: located.rects,
          quote: input.quote.trim(),
          note: input.note?.trim() || null,
          color: input.color ?? "yellow",
          ...(input.findingId ? { findingId: input.findingId } : {}),
        })
      );
      return { annotation, matches: located.matches };
    },

    async addNote(input: {
      projectKey: string;
      path: string;
      text: string;
      number?: number;
      page?: number;
      findingId?: string;
    }): Promise<PdfAnnotationDto> {
      assertPdf(input.path);
      const text = input.text.trim();
      if (!text) throw new UserError("note text must not be empty");
      if (input.number !== undefined) {
        const number = input.number;
        return update(input.projectKey, input.path, (file) => {
          const item = find(file, input.path, number);
          item.note = text;
          return item;
        });
      }
      if (input.page === undefined) {
        throw new UserError(`${input.path} is not open on screen, so there is no current page: open it, or pass page, number, or quote`);
      }
      const page = input.page;
      const size = await pageSize(await deps.readPdf(input.projectKey, input.path), page);
      return update(input.projectKey, input.path, (file) =>
        append(file, {
          page,
          ...size,
          rects: [],
          quote: null,
          note: text,
          color: "yellow",
          ...(input.findingId ? { findingId: input.findingId } : {}),
        })
      );
    },

    /** Replaces an annotation's note; null or blank clears it. A page note left without text is removed. */
    async setNote(projectKey: string, pdfPath: string, number: number, note: string | null): Promise<PdfAnnotationDto | null> {
      const text = note?.trim() || null;
      return update(projectKey, pdfPath, (file) => {
        const item = find(file, pdfPath, number);
        if (!text && item.quote === null) {
          file.items = file.items.filter((entry) => entry !== item);
          return null;
        }
        item.note = text;
        return item;
      });
    },

    /**
     * "pdf": the PDF with its annotations written in as standard Highlight and Text (sticky note) annotations.
     * "markdown": just the notes and highlighted passages, by page.
     */
    async export(projectKey: string, pdfPath: string, format: PdfAnnotationExportFormat): Promise<PdfAnnotationExport> {
      assertPdf(pdfPath);
      const items = (await read(projectKey)).files[pdfPath]?.items ?? [];
      if (items.length === 0) throw new UserError(`${pdfPath} has no highlights or notes to export`);
      const stem = path.posix.basename(pdfPath).replace(/\.pdf$/i, "");
      return format === "pdf"
        ? {
          data: await writeAnnotatedPdf(await deps.readPdf(projectKey, pdfPath), items),
          filename: `${stem}-annotated.pdf`,
          contentType: "application/pdf",
        }
        : {
          data: new TextEncoder().encode(notesMarkdown(pdfPath, items)),
          filename: `${stem}-notes.md`,
          contentType: "text/markdown; charset=utf-8",
        };
    },

    async remove(projectKey: string, pdfPath: string, number: number): Promise<PdfAnnotationDto> {
      return update(projectKey, pdfPath, (file) => {
        const item = find(file, pdfPath, number);
        file.items = file.items.filter((entry) => entry !== item);
        return item;
      });
    },

    forget(projectKey: string): Promise<void> {
      return exclusive(projectKey, () => fsp.rm(fileFor(projectKey), { force: true }));
    },
  };
}

export type PdfAnnotations = ReturnType<typeof createPdfAnnotations>;
