import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { githubCloneUrl } from "../shared/domain/contracts.js";
import { downloadRepository, githubArchiveUrl } from "../src/lib/github-archive.js";
import { createTestWorkspace, type TestWorkspace } from "./test.config.js";

const workspaces: TestWorkspace[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
});

test("only public GitHub repository links are accepted", () => {
  expect(githubCloneUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo.git");
  expect(githubCloneUrl(" https://github.com/owner/my.repo.git/ ")).toBe("https://github.com/owner/my.repo.git");
  expect(githubCloneUrl("https://github.com/owner")).toBeNull();
  expect(githubCloneUrl("https://github.com/owner/repo/tree/main")).toBeNull();
  expect(githubCloneUrl("http://github.com/owner/repo")).toBeNull();
  expect(githubCloneUrl("https://user:token@github.com/owner/repo")).toBeNull();
  expect(githubCloneUrl("--upload-pack=x")).toBeNull();
});

test("the default branch is fetched from codeload", () => {
  expect(githubArchiveUrl("https://github.com/owner/my.repo.git")).toBe(
    "https://codeload.github.com/owner/my.repo/tar.gz/HEAD",
  );
});

test("a download lands without its archive folder, and a failed one leaves nothing", async () => {
  const workspace = createTestWorkspace("github-archive");
  workspaces.push(workspace);
  const origin = path.join(workspace.root, "repo-abc123", "pkg");
  fs.mkdirSync(origin, { recursive: true });
  fs.writeFileSync(path.join(origin, "train.py"), "print('train')\n");
  const archive = execFileSync("tar", ["-cz", "-C", workspace.root, "repo-abc123"]);

  const fetchMock = vi.fn(async () => new Response(archive));
  vi.stubGlobal("fetch", fetchMock);
  const code = path.join(workspace.root, "code");
  await downloadRepository("https://github.com/owner/repo.git", code);
  expect(fetchMock).toHaveBeenCalledWith("https://codeload.github.com/owner/repo/tar.gz/HEAD", expect.anything());
  expect(fs.readdirSync(code)).toEqual(["pkg"]);
  expect(fs.readFileSync(path.join(code, "pkg", "train.py"), "utf8")).toBe("print('train')\n");

  vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
  const missing = path.join(workspace.root, "missing");
  await expect(downloadRepository("https://github.com/owner/nope.git", missing)).rejects.toThrow(/could not download.*HTTP 404/);
  expect(fs.existsSync(missing)).toBe(false);
});
