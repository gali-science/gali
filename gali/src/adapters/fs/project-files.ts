import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { IMPORT_SKIPPED_DIRECTORIES } from "../../../shared/domain/import-filter.js";
import { UserError } from "../../lib/user-error.js";
import { isPdfShadow, pdfShadowPath } from "../../lib/pdf-shadow.js";
import type { ProjectFile, ProjectFiles, ProjectMedia } from "../../ports/project-files.js";
import { isSensitivePath } from "./sensitive-path.js";

const MAX_TREE_ENTRIES = 2_000;
const MAX_READ_BYTES = 256 * 1024;
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_AV_BYTES = 100 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const VIEWABLE_IMAGES = new Map([
  [".avif", "image/avif"], [".bmp", "image/bmp"], [".gif", "image/gif"],
  [".jpeg", "image/jpeg"], [".jpg", "image/jpeg"], [".png", "image/png"],
  [".svg", "image/svg+xml"], [".webp", "image/webp"],
]);
const VIEWABLE_AUDIO = new Map([
  [".aac", "audio/aac"], [".aiff", "audio/aiff"], [".flac", "audio/flac"],
  [".m4a", "audio/mp4"], [".mp3", "audio/mpeg"], [".ogg", "audio/ogg"],
  [".wav", "audio/wav"], [".wma", "audio/x-ms-wma"],
]);
const VIEWABLE_VIDEO = new Map([
  [".m4v", "video/mp4"], [".mov", "video/quicktime"], [".mp4", "video/mp4"], [".webm", "video/webm"],
]);
const VIEWABLE_PDF = new Map([[".pdf", "application/pdf"]]);
const AUDIO = new Set([".aac", ".aiff", ".flac", ".m4a", ".mp3", ".ogg", ".wav", ".wma"]);
const IMAGE = new Set([".avif", ".bmp", ".gif", ".heic", ".jpeg", ".jpg", ".png", ".svg", ".tif", ".tiff", ".webp"]);
const VIDEO = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm", ".wmv"]);
const PDF = new Set([".pdf"]);
const TEXT_DATA = new Set([".csv", ".geojson", ".json", ".jsonl", ".ndjson", ".tsv", ".xml", ".yaml", ".yml"]);
const BINARY_DATA = new Set([".arrow", ".feather", ".h5", ".hdf5", ".npy", ".npz", ".parquet", ".sqlite", ".sqlite3"]);
const TEXT = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".ini", ".java",
  ".js", ".jsx", ".log", ".md", ".mjs", ".py", ".r", ".rb", ".rs", ".sh", ".sql",
  ".toml", ".ts", ".tsx", ".txt",
]);
const TEXT_FILENAMES = new Set([
  "authors", "changelog", "codeowners", "contributing", "dockerfile", "gemfile",
  "license", "makefile", "notice", "procfile", "rakefile", "readme",
  ".dockerignore", ".editorconfig", ".gitattributes", ".gitignore",
]);

function classify(filePath: string, bytes: number): ProjectFile {
  if (TEXT_FILENAMES.has(path.basename(filePath).toLowerCase())) {
    return { path: filePath, kind: "text", binary: false, bytes };
  }
  const extension = path.extname(filePath).toLowerCase();
  if (AUDIO.has(extension)) return { path: filePath, kind: "audio", binary: true, bytes };
  if (IMAGE.has(extension)) return { path: filePath, kind: "image", binary: extension !== ".svg", bytes };
  if (VIDEO.has(extension)) return { path: filePath, kind: "video", binary: true, bytes };
  if (PDF.has(extension)) return { path: filePath, kind: "pdf", binary: true, bytes };
  if (TEXT_DATA.has(extension)) return { path: filePath, kind: "data", binary: false, bytes };
  if (BINARY_DATA.has(extension)) return { path: filePath, kind: "data", binary: true, bytes };
  if (TEXT.has(extension)) return { path: filePath, kind: "text", binary: false, bytes };
  return { path: filePath, kind: "binary", binary: true, bytes };
}

export function previewProblem(
  filePath: string,
  bytes: number,
): "unsupported" | "too-large" | null {
  const extension = path.extname(filePath).toLowerCase();
  // SVG renders through the text read, so its display limit is the text one.
  const limit = extension === ".svg"
    ? MAX_READ_BYTES
    : VIEWABLE_IMAGES.has(extension)
      ? MAX_IMAGE_BYTES
      : VIEWABLE_AUDIO.has(extension) || VIEWABLE_VIDEO.has(extension)
        ? MAX_AV_BYTES
        : VIEWABLE_PDF.has(extension)
          ? MAX_PDF_BYTES
          : null;
  if (limit !== null) return bytes > limit ? "too-large" : null;
  if (!classify(filePath, bytes).binary) return null;
  return "unsupported";
}

export function isPreviewable(filePath: string, bytes = 0): boolean {
  return previewProblem(filePath, bytes) === null;
}

export type ViewerDisplay = "full" | "truncated" | "no-preview" | "too-large";

// Trims a byte window of a UTF-8 file to whole characters: drops leading
// continuation bytes (an arbitrary offset can land mid-character) and a
// trailing character broken by the byte cut, so chunks re-read from
// nextOffset concatenate into the exact original text.
export function sliceTextChunk(
  slice: Buffer,
  offset: number,
  totalBytes: number,
): { content: string; truncated?: boolean; nextOffset?: number } {
  let lead = 0;
  while (lead < slice.length && (slice[lead]! & 0b1100_0000) === 0b1000_0000) lead += 1;
  const body = slice.subarray(lead);
  if (offset + lead + body.length >= totalBytes) {
    return { content: body.toString("utf8") };
  }
  let end = body.length;
  let index = body.length - 1;
  let continuations = 0;
  while (index >= 0 && (body[index]! & 0b1100_0000) === 0b1000_0000) {
    index -= 1;
    continuations += 1;
  }
  if (index >= 0) {
    const first = body[index]!;
    const expected = first >= 0xf0 ? 3 : first >= 0xe0 ? 2 : first >= 0xc0 ? 1 : 0;
    if (expected !== continuations) end = index;
  }
  return {
    content: body.subarray(0, end).toString("utf8"),
    truncated: true,
    nextOffset: offset + lead + end,
  };
}

export function viewerDisplay(filePath: string, bytes: number): ViewerDisplay {
  const problem = previewProblem(filePath, bytes);
  if (problem === "too-large") return "too-large";
  if (problem === "unsupported") return "no-preview";
  if (!classify(filePath, bytes).binary && bytes > MAX_READ_BYTES) return "truncated";
  return "full";
}

function relativeInput(value: string): string {
  if (value.includes("\0") || path.isAbsolute(value)) throw new Error("path must be relative");
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.includes("..") || parts.includes(".git")) throw new Error("path traversal is not allowed");
  const result = parts.join("/");
  if (isSensitivePath(result)) throw new Error("sensitive paths cannot be accessed");
  return result;
}

async function containedPath(root: string, relativePath: string): Promise<string> {
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error("path escapes project");
  }
  const real = await fsp.realpath(candidate);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new Error("path escapes project");
  }
  return real;
}

async function walk(root: string, start: string, depth: number): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  let entries = 0;
  async function visit(directory: string, level: number): Promise<void> {
    if (level > depth) return;
    for (const child of await fsp.readdir(directory, { withFileTypes: true })) {
      if (child.isDirectory() && IMPORT_SKIPPED_DIRECTORIES.has(child.name.toLowerCase())) continue;
      entries += 1;
      if (entries > MAX_TREE_ENTRIES) throw new Error(`source listing exceeds ${MAX_TREE_ENTRIES} entries`);
      const absolute = path.join(directory, child.name);
      const relativePath = path.relative(root, absolute).split(path.sep).join("/");
      if (isSensitivePath(relativePath)) continue;
      const stat = await fsp.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`symbolic link is not allowed: ${relativePath}`);
      if (stat.isDirectory()) await visit(absolute, level + 1);
      else if (stat.isFile()) files.push(classify(relativePath, stat.size));
    }
  }
  const stat = await fsp.lstat(start);
  if (stat.isSymbolicLink()) throw new Error("symbolic links are not allowed");
  if (stat.isFile()) {
    const relativePath = path.relative(root, start).split(path.sep).join("/");
    return [classify(relativePath, stat.size)];
  }
  if (!stat.isDirectory()) throw new Error("source path is not a file or directory");
  await visit(start, 0);
  return files;
}

export function createProjectFiles(): ProjectFiles {
  return {
    async tree(rootInput, relativePathInput, depth) {
      const root = await fsp.realpath(rootInput);
      const relativePath = relativeInput(relativePathInput);
      try {
        const target = await containedPath(root, relativePath);
        const files = await walk(root, target, Math.min(Math.max(Math.trunc(depth), 0), 8));
        return files.filter((file) => !isPdfShadow(file.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },

    async readText(rootInput, relativePathInput, offsetInput = 0) {
      const root = await fsp.realpath(rootInput);
      let relativePath = relativeInput(relativePathInput);
      let target = await containedPath(root, relativePath);
      if (classify(relativePath, 0).kind === "pdf" && fs.existsSync(pdfShadowPath(target))) {
        relativePath = pdfShadowPath(relativePath);
        target = await containedPath(root, relativePath);
      }
      const stat = await fsp.lstat(target);
      if (!stat.isFile()) throw new UserError("read requires a file");
      const file = classify(relativePath, stat.size);
      if (file.binary) throw new UserError(`binary ${file.kind} files cannot be read`);
      const offset = Number.isFinite(offsetInput) ? Math.max(0, Math.trunc(offsetInput)) : 0;
      if (offset === 0 && file.bytes <= MAX_READ_BYTES) {
        return { file, content: await fsp.readFile(target, "utf8") };
      }
      const handle = await fsp.open(target, "r");
      try {
        const buffer = Buffer.alloc(MAX_READ_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, offset);
        return { file, ...sliceTextChunk(buffer.subarray(0, bytesRead), offset, file.bytes) };
      } finally {
        await handle.close();
      }
    },

    async readMedia(rootInput, relativePathInput) {
      const root = await fsp.realpath(rootInput);
      const relativePath = relativeInput(relativePathInput);
      const target = await containedPath(root, relativePath);
      const stat = await fsp.lstat(target);
      if (!stat.isFile()) throw new Error("read requires a file");
      const file = classify(relativePath, stat.size);
      const extension = path.extname(relativePath).toLowerCase();
      let mime: string | undefined;
      let kind: ProjectMedia["kind"] | null = null;
      let limit = 0;
      if (file.kind === "image") {
        mime = VIEWABLE_IMAGES.get(extension);
        kind = "image";
        limit = MAX_IMAGE_BYTES;
      } else if (file.kind === "audio") {
        mime = VIEWABLE_AUDIO.get(extension);
        kind = "audio";
        limit = MAX_AV_BYTES;
      } else if (file.kind === "video") {
        mime = VIEWABLE_VIDEO.get(extension);
        kind = "video";
        limit = MAX_AV_BYTES;
      } else if (file.kind === "pdf") {
        mime = VIEWABLE_PDF.get(extension);
        kind = "pdf";
        limit = MAX_PDF_BYTES;
      }
      if (!mime || !kind) throw new Error(`media format cannot be displayed: ${extension}`);
      if (file.bytes > limit) throw new Error(`media exceeds display limit of ${limit} bytes`);
      return {
        path: relativePath,
        kind,
        mime,
        data: await fsp.readFile(target),
      };
    },

    async searchText(rootInput, relativePathInput, query, depth, limit) {
      const root = await fsp.realpath(rootInput);
      const relativePath = relativeInput(relativePathInput);
      const target = await containedPath(root, relativePath);
      const files = await walk(root, target, Math.min(Math.max(Math.trunc(depth), 0), 8));
      const results: Array<{ path: string; line: number; page?: number; text: string }> = [];
      let bytes = 0;
      for (const file of files) {
        if (file.binary || file.bytes > MAX_READ_BYTES) continue;
        bytes += file.bytes;
        if (bytes > MAX_SEARCH_BYTES) break;
        const content = await fsp.readFile(path.join(root, file.path), "utf8");
        const shadow = isPdfShadow(file.path);
        let page = 0;
        for (const [index, line] of content.split(/\r?\n/).entries()) {
          const marker = shadow ? /^=== page (\d+)/.exec(line) : null;
          if (marker) page = Number(marker[1]);
          else if (line.toLowerCase().includes(query.toLowerCase())) {
            results.push({ path: file.path, line: index + 1, ...(shadow && page > 0 ? { page } : {}), text: line.slice(0, 500) });
            if (results.length >= limit) return results;
          }
        }
      }
      return results;
    },
  };
}
