import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { githubCloneUrl, MAX_CODE_ZIP_BYTES, MAX_PAPER_BYTES } from "../../../shared/domain/contracts.js";
import { UserError } from "../../lib/user-error.js";
import { extractZip } from "../../lib/zip.js";

export const IMPORT_UPLOAD_MAX_CHUNK_BYTES = 4 * 1024 * 1024;
// The wrapper zip stores its files uncompressed; 1 MB covers its headers.
export const IMPORT_UPLOAD_MAX_ZIP_BYTES = MAX_PAPER_BYTES + MAX_CODE_ZIP_BYTES + 1024 * 1024;
const STALE_UPLOAD_MS = 60 * 60 * 1000;

export type ImportUploadStatus<TProject> = {
  state: "receiving" | "importing" | "done" | "error";
  project?: TProject;
  error?: string;
};

type Upload<TProject> = {
  id: string;
  dir: string;
  zipPath: string;
  target: { title: string; codeUrl?: string };
  receivedBytes: number;
  nextChunk: number;
  status: ImportUploadStatus<TProject>;
};

/**
 * Receives one zip in chunks (the proxy in front of the sandbox caps request
 * size) and hands its extracted contents to `createProject`. The browser packs
 * the paper and, when given, the code zip into that one upload.
 */
export function createImportUploadService<TProject>(
  dataRoot: string,
  createProject: (input: { title: string; uploadDir: string; codeUrl?: string }) => Promise<TProject>,
) {
  const root = path.join(dataRoot, "import-uploads");
  const uploads = new Map<string, Upload<TProject>>();

  async function cleanupStale(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(root);
    } catch {
      return;
    }
    const now = Date.now();
    for (const name of names) {
      const active = uploads.get(name);
      if (active && active.status.state !== "done" && active.status.state !== "error") continue;
      const dir = path.join(root, name);
      try {
        const stat = await fsp.stat(dir);
        if (now - stat.mtimeMs < STALE_UPLOAD_MS) continue;
        await fsp.rm(dir, { recursive: true, force: true });
        uploads.delete(name);
      } catch {
        // another cleanup may have raced; leave it for the next pass
      }
    }
  }

  function getUpload(id: string): Upload<TProject> {
    const upload = uploads.get(id);
    if (!upload) throw new Error(`unknown import upload ${id}`);
    return upload;
  }

  async function runImport(upload: Upload<TProject>): Promise<void> {
    let result: ImportUploadStatus<TProject>;
    try {
      const extractDir = path.join(upload.dir, "extract");
      await extractZip(upload.zipPath, extractDir);
      result = { state: "done", project: await createProject({ ...upload.target, uploadDir: extractDir }) };
    } catch (error) {
      result = {
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    // Clean up before publishing the terminal state, so a client that sees
    // "done" never races the removal of the staging directory.
    await fsp.rm(upload.dir, { recursive: true, force: true }).catch(() => {});
    upload.status = result;
  }

  return {
    async init(input: { title?: string; codeUrl?: string }) {
      if (!input.title?.trim()) throw new Error("title required");
      if (input.codeUrl !== undefined && !githubCloneUrl(input.codeUrl)) {
        throw new UserError("the code link must look like https://github.com/owner/repo");
      }
      void cleanupStale();
      const id = randomUUID();
      const dir = path.join(root, id);
      await fsp.mkdir(dir, { recursive: true });
      uploads.set(id, {
        id,
        dir,
        zipPath: path.join(dir, "upload.zip"),
        target: {
          title: input.title.trim(),
          ...(input.codeUrl === undefined ? {} : { codeUrl: input.codeUrl }),
        },
        receivedBytes: 0,
        nextChunk: 0,
        status: { state: "receiving" },
      });
      return {
        uploadId: id,
        maxChunkBytes: IMPORT_UPLOAD_MAX_CHUNK_BYTES,
        maxZipBytes: IMPORT_UPLOAD_MAX_ZIP_BYTES,
      };
    },

    async appendChunk(id: string, index: number, data: Buffer) {
      const upload = getUpload(id);
      if (upload.status.state !== "receiving") {
        throw new Error(`import upload ${id} is not receiving chunks`);
      }
      if (!Number.isInteger(index) || index < 0) throw new Error("chunk index is invalid");
      // A retried chunk (response lost, client resent) is already on disk.
      if (index < upload.nextChunk) return { received: upload.nextChunk };
      if (index > upload.nextChunk) {
        throw new Error(`chunk ${index} is out of order; expected ${upload.nextChunk}`);
      }
      if (data.length === 0) throw new Error("chunk must not be empty");
      if (data.length > IMPORT_UPLOAD_MAX_CHUNK_BYTES) {
        throw new Error(`chunk exceeds ${IMPORT_UPLOAD_MAX_CHUNK_BYTES} bytes`);
      }
      if (upload.receivedBytes + data.length > IMPORT_UPLOAD_MAX_ZIP_BYTES) {
        upload.status = { state: "error", error: "upload exceeds the size limit" };
        await fsp.rm(upload.dir, { recursive: true, force: true }).catch(() => {});
        throw new Error(`upload exceeds ${IMPORT_UPLOAD_MAX_ZIP_BYTES} bytes`);
      }
      try {
        await fsp.appendFile(upload.zipPath, data);
      } catch (error) {
        // A failed append may have written partial data; the zip is unusable.
        upload.status = { state: "error", error: "chunk write failed" };
        throw error;
      }
      upload.receivedBytes += data.length;
      upload.nextChunk += 1;
      return { received: upload.nextChunk };
    },

    async finalize(id: string, input: { totalChunks: number; totalBytes: number }) {
      const upload = getUpload(id);
      if (upload.status.state !== "receiving") {
        throw new Error(`import upload ${id} is not receiving chunks`);
      }
      if (upload.nextChunk !== input.totalChunks || upload.receivedBytes !== input.totalBytes) {
        throw new Error(
          `upload is incomplete: have ${upload.nextChunk} chunks / ${upload.receivedBytes} bytes, `
          + `expected ${input.totalChunks} chunks / ${input.totalBytes} bytes`,
        );
      }
      if (upload.receivedBytes === 0) throw new Error("upload is empty");
      upload.status = { state: "importing" };
      void runImport(upload);
      return { state: upload.status.state };
    },

    status(id: string): ImportUploadStatus<TProject> {
      return getUpload(id).status;
    },
  };
}
