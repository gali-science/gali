import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { REVIEWER_AGENTS_MD } from "../../../src/agents/reviewer.js";
import { ensureCodexProfileHome } from "../../../src/agents/providers/codex/codex-home.js";
import { PAPER_CORRECTNESS_SKILL } from "../../../src/agents/skills/paper-correctness.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("the reviewer home carries only the paper-correctness skill, and drops stale ones", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gali-reviewer-home-"));
  roots.push(root);
  const profileRoot = path.join(root, "reviewer");
  fs.mkdirSync(path.join(profileRoot, "skills", "gali-writing"), { recursive: true });

  const home = await ensureCodexProfileHome({
    profileRoot,
    agentsMd: REVIEWER_AGENTS_MD,
    skills: [PAPER_CORRECTNESS_SKILL],
  });
  expect(fs.readdirSync(path.join(home, "skills"))).toEqual([PAPER_CORRECTNESS_SKILL.name]);
  expect(REVIEWER_AGENTS_MD).toContain(PAPER_CORRECTNESS_SKILL.name);
});

test("the reviewer writes KaTeX, not unicode soup", () => {
  expect(REVIEWER_AGENTS_MD).toContain("$inline$");
  expect(REVIEWER_AGENTS_MD).toContain("$$display$$");
  expect(REVIEWER_AGENTS_MD).toContain("KaTeX");
});

test("the reviewer only reviews papers: no Lab, draft, or research", () => {
  for (const research of ["Lab", "lab.json", "draft", "research", "data/"]) {
    expect(REVIEWER_AGENTS_MD).not.toContain(research);
  }
});

test("when the human is learning, the reviewer explains and adds only study findings", () => {
  expect(REVIEWER_AGENTS_MD).toContain("If the human asks you to explain, teach, or help them study the paper, explain\nonly. Do not look for problems, and do not add or change problem findings. When\nthey ask for practice problems, a worked example, or a visual, add study findings\nto review.json and change nothing else in it. For that turn, this rule wins\nover every rule above.");
  expect(REVIEWER_AGENTS_MD).toContain("- severity study is a practice problem, a worked example, or a visual that\n  explains the paper, for a human who is learning; the app lists it under \"To\n  study\". It is never a problem with the paper.");
  expect(REVIEWER_AGENTS_MD).toContain("Compute every number by running code, and put the steps\n  with their numbers in a table visual.");
  expect(REVIEWER_AGENTS_MD).toContain("For a visual, draw it as a chart, or as a\n  PNG or SVG figure saved under .review/figures/, and the body says in at most\n  50 words how to read it. The finding is the only place the human sees it: never\n  leave a visual as a loose file.");
  expect(PAPER_CORRECTNESS_SKILL.body).toContain("Leave any study findings as they are.");
  expect(REVIEWER_AGENTS_MD).toContain("When it only added study findings, say how many and that they are under To\nstudy in the Findings tab. In a reply, never call the findings \"the review\".");
  expect(REVIEWER_AGENTS_MD).not.toContain("that it is in the review");
});

test("Leo tags only a reply that hands work to a job and answers nothing, never a job report", () => {
  expect(REVIEWER_AGENTS_MD).toContain("When the reply only says that a background job started or was given more work, and\nanswers nothing else, begin it with [handoff]. Never put [handoff] in any other\nreply, and never when you report a finished background job.");
});

test("the reviewer suggests only references it opened and checked", () => {
  expect(REVIEWER_AGENTS_MD).toContain("Suggest a reference only after you opened it and checked that its DOI or link\nleads to that exact title. Never give a reference from memory.");
});

test("a file for the human goes where Browse code shows it, not in .review/", () => {
  expect(REVIEWER_AGENTS_MD).toContain("A file for the human (a list, a summary, notes) goes in the project folder, not\n.review/. They cannot see .review/.");
});

test("the reviewer grounds every judgment", () => {
  expect(REVIEWER_AGENTS_MD).toContain("Stay objective");
  expect(REVIEWER_AGENTS_MD).toContain("Taste is not a finding");
});

test("review.json rules live only in AGENTS.md, not in the skill or the subagent brief", () => {
  expect(PAPER_CORRECTNESS_SKILL.body).not.toContain("Substantive");
  expect(PAPER_CORRECTNESS_SKILL.body).not.toContain("50 words");
  expect(REVIEWER_AGENTS_MD).toContain("at least one ref");
  expect(REVIEWER_AGENTS_MD).toContain("Do not restate");
});

test("only the skill says a full review adds no ok findings", () => {
  expect(PAPER_CORRECTNESS_SKILL.body).toContain('The review lists problems only: no "ok" findings');
  expect(REVIEWER_AGENTS_MD).not.toContain("a full review lists");
});
