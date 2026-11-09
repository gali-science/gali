import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// When Gali runs as root (a hosted sandbox), Codex and every command it runs
// drop to this user. Linux then keeps them out of the server's environment
// (its secrets), /app, the database, and anything else root owns. They can
// write only the folders below.
export const AGENT_USER = "gali-agent";
// The agent's home lives in the data dir so its caches count against the
// hosted 1 GiB cap on /gali-data instead of filling the uncapped root disk.
export const AGENT_HOME_DIR = "agent-home";
export const AGENT_DIRS = ["papers", "codex-reviewer", AGENT_HOME_DIR] as const;

export type AgentIdentity = { uid: number; gid: number; home: string };

function isRoot(): boolean {
  return process.getuid?.() === 0;
}

function lookup(): AgentIdentity | null {
  for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
    const [name, , uid, gid, , home] = line.split(":");
    if (name === AGENT_USER) return { uid: Number(uid), gid: Number(gid), home: home! };
  }
  return null;
}

let cached: AgentIdentity | null | undefined;

/** Who Codex runs as, or null when the server is not root and Codex simply runs as the server's user. */
export function agentIdentity(): AgentIdentity | null {
  if (!isRoot()) return null;
  if (cached) return cached;
  cached = lookup();
  if (!cached) throw new Error(`running as root without the ${AGENT_USER} user; Codex must never run as root`);
  return cached;
}

/**
 * Idempotent, at every server start: older homes predate the agent user, and
 * files written there as root would otherwise stay out of the agent's reach.
 * The umask keeps what the server writes later closed to other users, so new
 * server folders stay private, while setgid agent folders hand the agent group
 * access to what the server writes inside them.
 */
export function prepareAgentUser(dataDir: string): AgentIdentity | null {
  if (!isRoot()) return null;
  const home = path.join(dataDir, AGENT_HOME_DIR);
  const existing = lookup();
  if (!existing) execFileSync("useradd", ["--no-create-home", "--home-dir", home, "--user-group", "--shell", "/usr/sbin/nologin", AGENT_USER]);
  else if (existing.home !== home) execFileSync("usermod", ["--home", home, AGENT_USER]);
  const agent = agentIdentity()!;
  process.umask(0o007);

  // Git refuses repositories owned by another user; root and the agent share these.
  // Exit 1 means the key is not set yet.
  const safe = spawnSync("git", ["config", "--system", "--get-all", "safe.directory"], { encoding: "utf8" });
  if (safe.status !== 0 && safe.status !== 1) throw new Error(`git config failed: ${safe.stderr}`);
  if (!safe.stdout.split("\n").includes("*")) execFileSync("git", ["config", "--system", "--add", "safe.directory", "*"]);

  fs.mkdirSync(dataDir, { recursive: true });
  fs.chmodSync(dataDir, 0o711);
  for (const entry of fs.readdirSync(dataDir)) {
    if ((AGENT_DIRS as readonly string[]).includes(entry)) continue;
    fs.chmodSync(path.join(dataDir, entry), 0o700);
  }
  const owner = `${agent.uid}:${agent.gid}`;
  for (const dir of AGENT_DIRS) {
    const root = path.join(dataDir, dir);
    fs.mkdirSync(root, { recursive: true });
    execFileSync("find", [root, "(", "!", "-uid", String(agent.uid), "-o", "!", "-gid", String(agent.gid), ")",
      "-exec", "chown", "-h", owner, "{}", "+"]);
    execFileSync("find", [root, "-type", "d", "!", "-perm", "-2000", "-exec", "chmod", "g+s", "{}", "+"]);
  }
  return agent;
}
