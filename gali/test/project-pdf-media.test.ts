import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createProjectFiles } from "../src/adapters/fs/project-files.js";

const files = createProjectFiles();
let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gali-pdf-"));
  fs.writeFileSync(path.join(root, "paper.pdf"), Buffer.from("%PDF-1.4 mock"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test("classifies pdf files as binary pdf", async () => {
  const tree = await files.tree(root, "", 1);
  const entry = tree.find((file) => file.path === "paper.pdf");
  expect(entry).toEqual({ path: "paper.pdf", kind: "pdf", binary: true, bytes: 13 });
});

test("serves pdf bytes through readMedia", async () => {
  const media = await files.readMedia(root, "paper.pdf");
  expect(media.kind).toBe("pdf");
  expect(media.mime).toBe("application/pdf");
  expect(media.data.toString("utf8")).toBe("%PDF-1.4 mock");
});

test("refuses text reads for pdf files", async () => {
  await expect(files.readText(root, "paper.pdf")).rejects.toThrow(
    /binary pdf files cannot be read/,
  );
});
