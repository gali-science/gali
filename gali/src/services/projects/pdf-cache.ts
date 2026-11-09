import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { IMPORT_SKIPPED_DIRECTORIES } from "../../../shared/domain/import-filter.js";
import { pdfShadowPath } from "../../lib/pdf-shadow.js";
import { withPdfDocument } from "./pdfium.js";

const PAGE_DPI = 150;
const MIN_PAGE_TEXT_CHARS = 20;

export type CachedPdf = {
  path: string;
  textPath: string;
  pagesDir: string;
  pageCount: number;
  textlessPages: number[];
};

type CacheMeta = {
  pageCount: number;
  textlessPages: number[];
};

function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rgb.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function build(bytes: Buffer, outDir: string): Promise<CacheMeta> {
  return withPdfDocument(bytes, async (doc) => {
    const sections: string[] = [];
    const textlessPages: number[] = [];
    for (let number = 1; number <= doc.pageCount; number += 1) {
      const { text, png } = doc.page(number, (page) => {
        const image = page.render(PAGE_DPI);
        return {
          text: page.text().replace(/\r\n/g, "\n").replace(/\uFFFE/g, ""),
          png: encodePng(image.width, image.height, image.rgb),
        };
      });
      if (text.trim().length < MIN_PAGE_TEXT_CHARS) {
        textlessPages.push(number);
        sections.push(`=== page ${number} (no text layer: scanned image) ===`);
      } else {
        sections.push(`=== page ${number} ===\n${text.trim()}`);
      }
      fs.writeFileSync(path.join(outDir, `page-${number}.png`), png);
      await new Promise((resolve) => setImmediate(resolve));
    }
    fs.writeFileSync(path.join(outDir, "text.txt"), `${sections.join("\n\n")}\n`);
    const meta: CacheMeta = { pageCount: doc.pageCount, textlessPages };
    fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta));
    return meta;
  });
}

function entry(pdfPath: string, dir: string, meta: CacheMeta): CachedPdf {
  return {
    path: pdfPath,
    textPath: path.join(dir, "text.txt"),
    pagesDir: dir,
    pageCount: meta.pageCount,
    textlessPages: meta.textlessPages,
  };
}

const building = new Map<string, Promise<CacheMeta>>();

async function buildInto(cacheRoot: string, hash: string, bytes: Buffer): Promise<CacheMeta> {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cacheRoot, `${hash}.tmp-`));
  try {
    const meta = await build(bytes, staging);
    fs.renameSync(staging, path.join(cacheRoot, hash));
    return meta;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function findPdfs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) {
        if (!item.name.startsWith(".") && !IMPORT_SKIPPED_DIRECTORIES.has(item.name.toLowerCase())) walk(path.join(dir, item.name));
      } else if (item.isFile() && item.name.toLowerCase().endsWith(".pdf")) {
        found.push(path.join(dir, item.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

function shadowText(cached: CachedPdf): string {
  const scanned = cached.textlessPages.length === 0
    ? ""
    : ` Pages with no text layer (scanned images): ${cached.textlessPages.join(", ")}.`;
  const header = `Page images for this PDF: ${cached.pagesDir}/page-N.png (N = 1..${cached.pageCount}).${scanned}`;
  return `${header}\n\n${fs.readFileSync(cached.textPath, "utf8")}`;
}

/** Writes or refreshes the text shadow beside every PDF under root; returns the PDFs that have one. */
export async function syncPdfShadows(cacheRoot: string, root: string): Promise<string[]> {
  const shadowed: string[] = [];
  for (const pdfPath of findPdfs(root)) {
    const shadow = pdfShadowPath(pdfPath);
    if (fs.existsSync(shadow) && fs.statSync(shadow).mtimeMs >= fs.statSync(pdfPath).mtimeMs) {
      shadowed.push(pdfPath);
      continue;
    }
    // A broken PDF inside the released code must not stop the paper's shadow.
    try {
      fs.writeFileSync(shadow, shadowText(await ensurePdfCache(cacheRoot, pdfPath)));
      shadowed.push(pdfPath);
    } catch (error) {
      console.warn(`[pdf-cache] no text shadow for ${pdfPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return shadowed;
}

export async function ensurePdfCache(cacheRoot: string, pdfPath: string): Promise<CachedPdf> {
  const bytes = fs.readFileSync(pdfPath);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const dir = path.join(cacheRoot, hash);
  const metaPath = path.join(dir, "meta.json");
  if (fs.existsSync(metaPath)) {
    return entry(pdfPath, dir, JSON.parse(fs.readFileSync(metaPath, "utf8")) as CacheMeta);
  }
  let pending = building.get(hash);
  if (!pending) {
    pending = buildInto(cacheRoot, hash, bytes).finally(() => building.delete(hash));
    building.set(hash, pending);
  }
  return entry(pdfPath, dir, await pending);
}
