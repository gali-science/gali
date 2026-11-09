import { zip, type AsyncZippable } from "fflate";
import {
  MAX_CODE_ZIP_BYTES,
  MAX_PAPER_BYTES,
  PAPER_DIR,
  UPLOAD_CODE_ZIP,
  type ProjectDto,
} from "../../../../shared/domain/contracts";
import { getPlatform } from "../../platform/runtime";

const CHUNK_BYTES = 3 * 1024 * 1024;
const CHUNK_ATTEMPTS = 3;
const POLL_EVERY_MS = 1_500;
const POLL_TIMEOUT_MS = 10 * 60 * 1_000;

export type PaperUploadPhase =
  | { step: "packing" }
  | { step: "uploading"; sent: number; total: number }
  | { step: "importing" };

export function checkPaperFile(file: File): void {
  if (!file.name.toLowerCase().endsWith(".pdf")) throw new Error("the file must be a .pdf");
  if (file.size > MAX_PAPER_BYTES) throw new Error("the paper exceeds the 100 MB limit");
}

export function checkCodeZip(file: File): void {
  if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("the code must be a .zip file");
  if (file.size > MAX_CODE_ZIP_BYTES) throw new Error("the code zip exceeds the 100 MB limit");
}

function client() {
  const g = getPlatform().client;
  if (!g) throw new Error("Uploading needs a connected Gali runtime.");
  return g;
}

// The code zip goes in stored, untouched; the server unpacks it.
function pack(entries: AsyncZippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(entries, { level: 0 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

async function sendChunk(uploadId: string, index: number, data: Uint8Array): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CHUNK_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, attempt * 1_000));
    try {
      await client().send(
        "POST",
        `/import-uploads/${uploadId}/chunks/${index}`,
        new Blob([data as Uint8Array<ArrayBuffer>]),
        "application/octet-stream",
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function uploadPaperProject(input: {
  title: string;
  paper: File;
  /** At most one of the two; with neither, the project has no code. */
  code?: File;
  codeUrl?: string;
  onPhase: (phase: PaperUploadPhase) => void;
}): Promise<ProjectDto> {
  const { title, paper, code, codeUrl, onPhase } = input;
  checkPaperFile(paper);
  if (code) checkCodeZip(code);

  onPhase({ step: "packing" });
  const packed = await pack({
    [`${PAPER_DIR}/${paper.name}`]: new Uint8Array(await paper.arrayBuffer()),
    ...(code ? { [UPLOAD_CODE_ZIP]: new Uint8Array(await code.arrayBuffer()) } : {}),
  });
  return sendUpload({ title, ...(codeUrl ? { codeUrl } : {}) }, packed, onPhase);
}

async function sendUpload(
  body: Record<string, string>,
  packed: Uint8Array,
  onPhase: (phase: PaperUploadPhase) => void,
): Promise<ProjectDto> {
  const init = await client().json<{ uploadId: string; maxChunkBytes: number }>(
    "POST",
    "/import-uploads",
    body,
  );
  const chunkBytes = Math.min(CHUNK_BYTES, init.maxChunkBytes);
  const totalChunks = Math.ceil(packed.length / chunkBytes);
  for (let index = 0; index < totalChunks; index++) {
    onPhase({ step: "uploading", sent: index * chunkBytes, total: packed.length });
    await sendChunk(
      init.uploadId,
      index,
      packed.subarray(index * chunkBytes, Math.min((index + 1) * chunkBytes, packed.length)),
    );
  }

  onPhase({ step: "importing" });
  await client().json("POST", `/import-uploads/${init.uploadId}/finalize`, {
    totalChunks,
    totalBytes: packed.length,
  });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  // The proxy in front of the sandbox drops requests now and then; a lone
  // failed poll must not abandon an import that is still running server-side.
  let failedPolls = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_EVERY_MS));
    let status: { state: string; project?: ProjectDto; error?: string };
    try {
      status = await client().json("GET", `/import-uploads/${init.uploadId}`);
      failedPolls = 0;
    } catch (error) {
      failedPolls += 1;
      if (failedPolls >= 4) throw error;
      continue;
    }
    if (status.state === "done" && status.project) return status.project;
    if (status.state === "error") throw new Error(status.error ?? "import failed");
    if (Date.now() > deadline) throw new Error("import timed out");
  }
}
