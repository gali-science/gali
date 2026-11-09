import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { agentIdentity, prepareAgentUser } from "../../../../src/agents/providers/codex/agent-user.js";

afterEach(() => {
  vi.restoreAllMocks();
});

test("a non-root server runs Codex as itself and leaves the data folder alone", () => {
  vi.spyOn(process, "getuid").mockReturnValue(501);
  const dataDir = path.join(os.tmpdir(), `gali-agent-user-${process.pid}`);
  expect(agentIdentity()).toBeNull();
  expect(prepareAgentUser(dataDir)).toBeNull();
  expect(fs.existsSync(dataDir)).toBe(false);
});

test("a root server without the agent user refuses to start Codex", () => {
  vi.spyOn(process, "getuid").mockReturnValue(0);
  vi.spyOn(fs, "readFileSync").mockReturnValue("root:x:0:0:root:/root:/bin/bash\n");
  expect(() => agentIdentity()).toThrow(/Codex must never run as root/);
});
