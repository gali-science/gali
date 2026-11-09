import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_CONFIG = {
  integrationTimeoutMs: 30_000,
  liveSmokeTimeoutMs: 20 * 60_000,
  pollIntervalMs: 250,
} as const;

export type TestWorkspace = {
  root: string;
  dataDir: string;
  dbPath: string;
  repoPath: string;
  cleanup(): void;
};

export function createTestWorkspace(name: string): TestWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gali-${name}-`));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  return {
    root,
    dataDir,
    dbPath: path.join(dataDir, "db"),
    repoPath: path.join(root, "project"),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
