import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  defaultCodexHome,
  ensureCodexProfileHome,
} from "../../../../src/agents/providers/codex/codex-home.js";
import { REVIEWER_AGENTS_MD } from "../../../../src/agents/reviewer.js";
import { PAPER_CORRECTNESS_SKILL } from "../../../../src/agents/skills/paper-correctness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("defaultCodexHome prefers CODEX_HOME env", () => {
  expect(defaultCodexHome({ CODEX_HOME: "/tmp/custom-codex" })).toBe(
    path.resolve("/tmp/custom-codex"),
  );
});

test("ensureCodexProfileHome writes AGENTS.md and links auth from base home", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gali-codex-home-"));
  roots.push(root);
  const base = path.join(root, "base");
  const profile = path.join(root, "leo");
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "auth.json"), '{"ok":true}\n');
  fs.writeFileSync(path.join(base, "config.toml"), "model = \"test\"\n");

  const home = await ensureCodexProfileHome({
    profileRoot: profile,
    agentsMd: REVIEWER_AGENTS_MD,
    baseHome: base,
  });

  expect(home).toBe(path.resolve(profile));
  expect(fs.readFileSync(path.join(home, "AGENTS.md"), "utf8")).toBe(REVIEWER_AGENTS_MD);
  expect(fs.readlinkSync(path.join(home, "auth.json"))).toBe(path.join(base, "auth.json"));
  expect(fs.readlinkSync(path.join(home, "config.toml"))).toBe(path.join(base, "config.toml"));
  expect(fs.readFileSync(path.join(home, "auth.json"), "utf8")).toContain('"ok":true');
});

test("ensureCodexProfileHome retargets shared links when base home changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gali-codex-retarget-"));
  roots.push(root);
  const oldBase = path.join(root, "old");
  const newBase = path.join(root, "sandbox");
  const profile = path.join(root, "leo");
  fs.mkdirSync(oldBase, { recursive: true });
  fs.mkdirSync(newBase, { recursive: true });
  fs.writeFileSync(path.join(oldBase, "config.toml"), "old = true\n");
  fs.writeFileSync(path.join(newBase, "config.toml"), 'model = "new"\n');
  fs.writeFileSync(path.join(oldBase, "auth.json"), '{"old":true}\n');
  fs.writeFileSync(path.join(newBase, "auth.json"), '{"new":true}\n');

  await ensureCodexProfileHome({
    profileRoot: profile,
    agentsMd: "v1\n",
    baseHome: oldBase,
  });
  await ensureCodexProfileHome({
    profileRoot: profile,
    agentsMd: "v2\n",
    baseHome: newBase,
  });

  expect(fs.readlinkSync(path.join(profile, "config.toml"))).toBe(path.join(newBase, "config.toml"));
  expect(fs.readFileSync(path.join(profile, "config.toml"), "utf8")).toContain("new");
});

test("ensureCodexProfileHome refreshes AGENTS.md on later calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gali-codex-refresh-"));
  roots.push(root);
  const profile = path.join(root, "worker");
  await ensureCodexProfileHome({ profileRoot: profile, agentsMd: "v1\n" });
  await ensureCodexProfileHome({ profileRoot: profile, agentsMd: REVIEWER_AGENTS_MD });
  expect(fs.readFileSync(path.join(profile, "AGENTS.md"), "utf8")).toBe(REVIEWER_AGENTS_MD);
});

test("ensureCodexProfileHome writes skills where Codex discovers them", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gali-codex-skills-"));
  roots.push(root);
  const profile = path.join(root, "leo");

  const home = await ensureCodexProfileHome({
    profileRoot: profile,
    agentsMd: REVIEWER_AGENTS_MD,
    skills: [PAPER_CORRECTNESS_SKILL],
  });

  const skillPath = path.join(home, "skills", PAPER_CORRECTNESS_SKILL.name, "SKILL.md");
  const body = fs.readFileSync(skillPath, "utf8");
  const [, frontmatter] = body.split("---\n", 2);
  expect(frontmatter).toContain(`name: ${PAPER_CORRECTNESS_SKILL.name}`);
  expect(frontmatter).toMatch(/^description: .+$/m);
  expect(frontmatter).not.toMatch(/description:[^\n]{501}/);
  expect(body).toContain(PAPER_CORRECTNESS_SKILL.body.trim().split("\n")[0]!);
});

test("ensureCodexProfileHome drops skills that are no longer registered", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gali-codex-stale-"));
  roots.push(root);
  const profile = path.join(root, "leo");

  await ensureCodexProfileHome({
    profileRoot: profile,
    agentsMd: "v1\n",
    skills: [{ name: "retired-skill", description: "Old skill.", body: "body" }],
  });
  await ensureCodexProfileHome({
    profileRoot: profile,
    agentsMd: "v1\n",
    skills: [PAPER_CORRECTNESS_SKILL],
  });

  expect(fs.existsSync(path.join(profile, "skills", "retired-skill"))).toBe(false);
  expect(fs.existsSync(path.join(profile, "skills", PAPER_CORRECTNESS_SKILL.name))).toBe(true);
});

test("ensureCodexProfileHome rejects a skill Codex would fail to parse", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gali-codex-bad-skill-"));
  roots.push(root);
  await expect(
    ensureCodexProfileHome({
      profileRoot: path.join(root, "leo"),
      agentsMd: "v1\n",
      skills: [{ name: "Bad Name", description: "d", body: "b" }],
    }),
  ).rejects.toThrow(/invalid Codex skill name/);
});
