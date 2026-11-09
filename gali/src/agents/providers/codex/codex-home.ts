import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodexSkill } from "../../skills/types.js";
import { agentIdentity } from "./agent-user.js";

const SHARED = ["auth.json", "config.toml"] as const;

const SKILL_NAME_MAX = 100;
const SKILL_DESCRIPTION_MAX = 500;

function skillFrontmatter(skill: CodexSkill): string {
  const name = skill.name.trim();
  const description = skill.description.replace(/\s+/g, " ").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || name.length > SKILL_NAME_MAX) {
    throw new Error(`invalid Codex skill name: ${skill.name}`);
  }
  if (!description || description.length > SKILL_DESCRIPTION_MAX) {
    throw new Error(
      `Codex skill ${name} needs a description of 1-${SKILL_DESCRIPTION_MAX} chars, got ${description.length}`,
    );
  }
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${skill.body.trimStart()}`;
}

// Codex discovers $CODEX_HOME/skills/<dir>/SKILL.md at startup and injects only the
// frontmatter plus path, opening the body on demand. Writing skills into the per-agent
// home is what scopes them to one agent.
async function writeSkills(home: string, skills: CodexSkill[]): Promise<void> {
  const root = path.join(home, "skills");
  await fsp.rm(root, { recursive: true, force: true });
  if (skills.length === 0) return;
  for (const skill of skills) {
    const dir = path.join(root, skill.name);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, "SKILL.md"), skillFrontmatter(skill), "utf8");
  }
}

export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  if (configured) return path.resolve(configured);
  return path.join(os.homedir(), ".codex");
}

export async function ensureCodexProfileHome(opts: {
  profileRoot: string;
  agentsMd: string;
  baseHome?: string;
  skills?: CodexSkill[];
}): Promise<string> {
  const home = path.resolve(opts.profileRoot);
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(path.join(home, "AGENTS.md"), opts.agentsMd, "utf8");
  await writeSkills(home, opts.skills ?? []);

  // The agent user cannot read root's home, and hosted credentials come from the
  // environment, so there is nothing to share when Codex runs as the agent.
  const base = path.resolve(opts.baseHome ?? defaultCodexHome());
  if (base !== home && agentIdentity() === null) {
    for (const name of SHARED) {
      const dest = path.join(home, name);
      const src = path.join(base, name);
      try {
        await fsp.access(src);
      } catch {
        // tests / fake providers may not have a real Codex home
        continue;
      }
      // Always retarget: older profiles may still point at a read-only platform ~/.codex.
      await fsp.rm(dest, { force: true });
      await fsp.symlink(src, dest);
    }
  }
  return home;
}
