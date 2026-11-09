import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { isExcludedImportPath } from "../../shared/domain/import-filter.js";

const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED_ENTRIES = 50_000;
const UNIX_MODE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;

function openZipFile(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, zipfile) => {
      if (error) reject(error);
      else resolve(zipfile);
    });
  });
}

function openEntryStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

export async function extractZip(zipPath: string, destination: string): Promise<void> {
  await fsp.mkdir(destination, { recursive: true });
  const zipfile = await openZipFile(zipPath);
  let entries = 0;
  let bytes = 0;

  async function extractEntry(entry: yauzl.Entry): Promise<void> {
    const raw = entry.fileName;
    if (raw.includes("\0")) throw new Error("zip entry name contains a null byte");
    const normalized = raw.replaceAll("\\", "/");
    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
      throw new Error("zip entry must use a relative path");
    }
    const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
    if (parts.includes("..")) throw new Error("zip entry path traversal is not allowed");
    if (parts.length === 0) return;
    if (((entry.externalFileAttributes >>> 16) & UNIX_MODE_MASK) === UNIX_SYMLINK) return;
    if (isExcludedImportPath(parts.join("/"))) return;
    entries += 1;
    if (entries > MAX_EXTRACTED_ENTRIES) {
      throw new Error(`zip exceeds ${MAX_EXTRACTED_ENTRIES} entries`);
    }
    const target = path.join(destination, ...parts);
    if (target !== destination && !target.startsWith(`${destination}${path.sep}`)) {
      throw new Error("zip entry escapes the extraction directory");
    }
    if (normalized.endsWith("/")) {
      await fsp.mkdir(target, { recursive: true });
      return;
    }
    // yauzl validates the actual stream length against this declared size, so
    // counting it up front is a safe zip-bomb guard.
    bytes += entry.uncompressedSize;
    if (bytes > MAX_EXTRACTED_BYTES) throw new Error("zip exceeds 2 GiB");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const source = await openEntryStream(zipfile, entry);
    await pipeline(source, fs.createWriteStream(target));
  }

  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      try {
        zipfile.close();
      } catch {
        // already closed
      }
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    zipfile.on("error", fail);
    zipfile.on("end", () => resolve());
    zipfile.on("entry", (entry: yauzl.Entry) => {
      extractEntry(entry).then(() => zipfile.readEntry(), fail);
    });
    zipfile.readEntry();
  });
}

/** GitHub-style archives wrap everything in one folder; the code root is its contents. */
export async function unwrapSingleFolder(dir: string): Promise<void> {
  const children = await fsp.readdir(dir, { withFileTypes: true });
  if (children.length !== 1 || !children[0]!.isDirectory()) return;
  const inner = path.join(dir, children[0]!.name);
  const staging = `${dir}.unwrap`;
  await fsp.rename(inner, staging);
  await fsp.rm(dir, { recursive: true });
  await fsp.rename(staging, dir);
}
