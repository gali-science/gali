import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { ensurePdfCache } from "../src/services/projects/pdf-cache.js";
import { minimalPdf } from "./fixtures/minimal-pdf.js";
import { createTestWorkspace, type TestWorkspace } from "./test.config.js";

const workspaces: TestWorkspace[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
  vi.restoreAllMocks();
});

function workspace(): TestWorkspace {
  const created = createTestWorkspace("pdf-cache");
  workspaces.push(created);
  return created;
}

test("builds a page-marked text copy and one PNG per page, then reuses it", async () => {
  const ws = workspace();
  const pdfPath = path.join(ws.root, "paper.pdf");
  fs.writeFileSync(pdfPath, minimalPdf(["Scaled dot-product attention divides by sqrt dk", ""]));
  const cacheRoot = path.join(ws.dataDir, "pdf-cache");

  const first = await ensurePdfCache(cacheRoot, pdfPath);

  expect(first.pageCount).toBe(2);
  expect(first.textlessPages).toEqual([2]);
  const text = fs.readFileSync(first.textPath, "utf8");
  expect(text).toContain("=== page 1 ===\nScaled dot-product attention divides by sqrt dk");
  expect(text).toContain("=== page 2 (no text layer: scanned image) ===");
  for (const page of [1, 2]) {
    const png = fs.readFileSync(path.join(first.pagesDir, `page-${page}.png`));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(1275);
    expect(png.readUInt32BE(20)).toBe(1650);
  }
  expect(path.dirname(first.pagesDir)).toBe(cacheRoot);
  expect(fs.readdirSync(cacheRoot)).toEqual([path.basename(first.pagesDir)]);

  const builtAt = fs.statSync(first.textPath).mtimeMs;
  const second = await ensurePdfCache(cacheRoot, pdfPath);
  expect(second).toEqual(first);
  expect(fs.statSync(second.textPath).mtimeMs).toBe(builtAt);
});

test("simultaneous requests for the same PDF share one build", async () => {
  const ws = workspace();
  const pdfPath = path.join(ws.root, "paper.pdf");
  fs.writeFileSync(pdfPath, minimalPdf(["Upload warm-up and first look-up at once", "", ""]));
  const cacheRoot = path.join(ws.dataDir, "pdf-cache");

  const [warm, lookup] = await Promise.all([
    ensurePdfCache(cacheRoot, pdfPath),
    ensurePdfCache(cacheRoot, pdfPath),
  ]);

  expect(lookup).toEqual(warm);
  expect(fs.readdirSync(cacheRoot)).toEqual([path.basename(warm.pagesDir)]);
  expect(fs.readdirSync(warm.pagesDir).sort()).toEqual([
    "meta.json",
    "page-1.png",
    "page-2.png",
    "page-3.png",
    "text.txt",
  ]);
});
