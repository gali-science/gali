import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createProjectFiles } from "../src/adapters/fs/project-files.js";
import { createTestWorkspace, type TestWorkspace } from "./test.config.js";

const MAX_READ_BYTES = 256 * 1024;

let workspace: TestWorkspace;

beforeAll(() => {
  workspace = createTestWorkspace("read-truncation");
});

afterAll(() => {
  workspace.cleanup();
});

test("fs readText truncates oversized text files instead of throwing", async () => {
  const files = createProjectFiles();
  const root = workspace.repoPath;
  fs.mkdirSync(root, { recursive: true });

  fs.writeFileSync(path.join(root, "small.md"), "short\n");
  const small = await files.readText(root, "small.md");
  expect(small.content).toBe("short\n");
  expect(small.truncated).toBeUndefined();

  const line = "é".repeat(63) + "\n";
  fs.writeFileSync(path.join(root, "big.log"), line.repeat(Math.ceil((MAX_READ_BYTES + 4096) / Buffer.byteLength(line))));
  const big = await files.readText(root, "big.log");
  expect(big.truncated).toBe(true);
  expect(Buffer.byteLength(big.content, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
  expect(big.content.startsWith("é")).toBe(true);
  expect(big.content.includes("\uFFFD")).toBe(false);
});

test("fs readText chunks reassemble the exact file through nextOffset", async () => {
  const files = createProjectFiles();
  const root = workspace.repoPath;
  fs.mkdirSync(root, { recursive: true });

  const line = "é".repeat(63) + "\n";
  const whole = line.repeat(Math.ceil((2 * MAX_READ_BYTES + 4096) / Buffer.byteLength(line)));
  fs.writeFileSync(path.join(root, "chunks.log"), whole);

  let assembled = "";
  let offset = 0;
  for (let guard = 0; guard < 10; guard++) {
    const chunk = await files.readText(root, "chunks.log", offset);
    expect(chunk.content.includes("\uFFFD")).toBe(false);
    assembled += chunk.content;
    if (!chunk.truncated) break;
    expect(chunk.nextOffset).toBeGreaterThan(offset);
    offset = chunk.nextOffset!;
  }
  expect(assembled).toBe(whole);
  fs.unlinkSync(path.join(root, "chunks.log"));
});
