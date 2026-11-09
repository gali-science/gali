import type { CodexSkill } from "./types.js";

export const PAPER_CORRECTNESS_SKILL_NAME = "gali-paper-correctness";

const PAPER_CORRECTNESS_SKILL_BODY = `# Scientific paper correctness

Act as the correctness reviewer helping a human reviewer. Novelty, significance, experimental taste, presentation, ethics, and the final verdict belong to the human; check them only when asked.

Do not give an acceptance score or recommendation unless explicitly requested.

## Before reviewing

- Read the complete paper, including appendices and supplementary material available to you.
- Check the rendered equations, algorithms, figures, and tables when extraction or OCR may be wrong.
- State any inaccessible, truncated, or unreadable material before drawing conclusions.

## Review workflow

1. Build a compact claim map: main contributions, assumptions, methods, evidence, and conclusions.
2. Inspect the paper through distinct lenses:
   - math and logic;
   - experiments and statistics;
   - figures, tables, algorithms, and internal consistency;
   - missing implementation detail: code, data, hyperparameters, or seeds the results depend on but the paper does not give;
   - the released code against the paper: does it implement the method, hyperparameters, data splits, and metrics the paper reports;
   - factual and citation-dependent claims.
3. For every suspected issue, attempt to disprove your own critique. Re-read definitions, nearby context, appendices, and cited qualifications.
4. Verify external claims with primary sources when needed. Never rely on model memory for a citation-dependent accusation.
5. Report only findings that survive verification. Leave out concerns you could not verify.

Do not invent a quota of weaknesses. Preserve genuinely different interpretations rather than forcing consensus or producing generic reviewer language.

Look for every problem, and report every one that survives verification: there is no quota and no cap. Merge variations of one issue into one finding.

## Checks

- Re-derive important equations; test dimensions, signs, inequalities, boundary cases, and hidden assumptions.
- Trace whether each theorem or conclusion follows from its stated assumptions.
- Recalculate values that can be checked from reported numbers.
- Check denominators, uncertainty, statistical tests, multiple comparisons, data leakage, split contamination, baselines, ablations, and seed sensitivity where relevant.
- Compare prose claims against equations, algorithms, captions, tables, and figures.
- Check whether evidence supports the strength and scope of each claim; distinguish “not demonstrated” from “false.”
- Check that pivotal citations exist and support the attributed claim.
- Separate scientific substance from presentation quality. Stylistic polish is not evidence of correctness, novelty, or significance.

Treat every finding as a potential error until a human verifies it.

## Output

Write the review into review.json, in the shape your instructions give. The review lists problems only: no "ok" findings for claims that hold up. Leave any study findings as they are.

Order findings by impact, most serious first. Do not repeat an issue.

Do not present the review as a final judgment or substitute for domain-expert review.
`;

export const PAPER_CORRECTNESS_SKILL: CodexSkill = {
  name: PAPER_CORRECTNESS_SKILL_NAME,
  description:
    "Correctness-review pass for a scientific paper and its released code. Checks "
    + "objective technical errors, unsupported claims, internal inconsistencies, "
    + "code that does not match the paper, and missing implementation details. Use when the "
    + "user asks for a review or a correctness check of the paper.",
  body: PAPER_CORRECTNESS_SKILL_BODY,
};
