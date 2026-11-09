import fs from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createImportUploadService } from "../src/services/projects/import-upload-service.js";
import { createTestWorkspace, type TestWorkspace } from "./test.config.js";

let workspace: TestWorkspace;

beforeAll(() => {
  workspace = createTestWorkspace("import-upload");
});

afterAll(() => {
  workspace.cleanup();
});

function listFiles(root: string, dir = root): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(root, absolute));
    else out.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
  return out.sort();
}

function makeService() {
  const titles: string[] = [];
  const inputs: string[][] = [];
  const extracted: string[][] = [];
  const contents: Record<string, string>[] = [];
  const service = createImportUploadService(workspace.dataDir, async (input) => {
    titles.push(input.title);
    inputs.push(Object.keys(input).sort());
    const files = listFiles(input.uploadDir);
    extracted.push(files);
    contents.push(Object.fromEntries(
      files.map((file) => [file, fs.readFileSync(path.join(input.uploadDir, file), "utf8")]),
    ));
    return { key: "created" };
  });
  return { service, titles, inputs, extracted, contents };
}

async function waitSettled(service: ReturnType<typeof makeService>["service"], uploadId: string) {
  for (let i = 0; i < 400; i++) {
    const status = service.status(uploadId);
    if (status.state === "done" || status.state === "error") return status;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("import upload never settled");
}

test("chunked upload extracts the zip, filters exclusions, and creates the project", async () => {
  const { service, titles, extracted, contents } = makeService();
  const zipped = zipSync({
    "paper/main.pdf": strToU8("%PDF-1.4"),
    "code.zip": strToU8("inner"),
    "node_modules/pkg/index.js": strToU8("skip me"),
    ".env": strToU8("SECRET=1"),
    ".DS_Store": strToU8("junk"),
  });

  const init = await service.init({ title: "Demo" });
  const half = Math.ceil(zipped.length / 2);
  const first = Buffer.from(zipped.subarray(0, half));
  const second = Buffer.from(zipped.subarray(half));
  await service.appendChunk(init.uploadId, 0, first);
  await service.appendChunk(init.uploadId, 1, second);

  // A retried chunk whose response was lost is acknowledged, not re-appended.
  await expect(service.appendChunk(init.uploadId, 0, first)).resolves.toEqual({ received: 2 });
  await expect(service.appendChunk(init.uploadId, 5, second)).rejects.toThrow(/out of order/);
  await expect(
    service.finalize(init.uploadId, { totalChunks: 3, totalBytes: zipped.length }),
  ).rejects.toThrow(/incomplete/);

  await service.finalize(init.uploadId, { totalChunks: 2, totalBytes: zipped.length });
  const status = await waitSettled(service, init.uploadId);

  expect(status).toEqual({ state: "done", project: { key: "created" } });
  expect(titles).toEqual(["Demo"]);
  expect(extracted[0]).toEqual(["code.zip", "paper/main.pdf"]);
  expect(contents[0]!["paper/main.pdf"]).toBe("%PDF-1.4");
  expect(fs.existsSync(path.join(workspace.dataDir, "import-uploads", init.uploadId))).toBe(false);
});

test("an upload requires a title", async () => {
  const { service } = makeService();
  await expect(service.init({ title: " " })).rejects.toThrow(/title required/);
});

test("an upload creates a project from its title and code link only, never a question or data", async () => {
  const { service, inputs } = makeService();
  const zipped = zipSync({ "paper/main.pdf": strToU8("%PDF-1.4") });
  const init = await service.init({ title: "Asked", question: "Is it fair?", dataName: "speakers.zip" } as { title: string });
  await service.appendChunk(init.uploadId, 0, Buffer.from(zipped));
  await service.finalize(init.uploadId, { totalChunks: 1, totalBytes: zipped.length });
  await waitSettled(service, init.uploadId);
  expect(inputs).toEqual([["title", "uploadDir"]]);
});

test("zip entries with path traversal fail the import", async () => {
  const { service, titles } = makeService();
  const zipped = zipSync({ "../evil.txt": strToU8("nope") });

  const init = await service.init({ title: "Evil" });
  await service.appendChunk(init.uploadId, 0, Buffer.from(zipped));
  await service.finalize(init.uploadId, { totalChunks: 1, totalBytes: zipped.length });
  const status = await waitSettled(service, init.uploadId);

  expect(status.state).toBe("error");
  // Either our guard or yauzl's own file-name validation may fire first.
  expect(status.error).toMatch(/traversal|relative path|invalid/i);
  expect(titles).toHaveLength(0);
  expect(fs.existsSync(path.join(workspace.dataDir, "import-uploads", init.uploadId))).toBe(false);
});

test("symlink zip entries are skipped", async () => {
  const { service, extracted } = makeService();
  const zipped = zipSync({
    "real.txt": strToU8("ok"),
    "link.txt": [strToU8("/etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }],
  });

  const init = await service.init({ title: "Links" });
  await service.appendChunk(init.uploadId, 0, Buffer.from(zipped));
  await service.finalize(init.uploadId, { totalChunks: 1, totalBytes: zipped.length });
  const status = await waitSettled(service, init.uploadId);

  expect(status.state).toBe("done");
  expect(extracted[0]).toEqual(["real.txt"]);
});

test("finalize requires every chunk to have arrived", async () => {
  const { service } = makeService();
  const zipped = zipSync({ "a.txt": strToU8("a") });

  const init = await service.init({ title: "Partial" });
  await service.appendChunk(init.uploadId, 0, Buffer.from(zipped));
  await expect(
    service.finalize(init.uploadId, { totalChunks: 2, totalBytes: zipped.length + 10 }),
  ).rejects.toThrow(/incomplete/);
});
