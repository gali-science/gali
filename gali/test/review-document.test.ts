import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createReviewDocuments, parseReviewDocument } from "../src/services/review/review-document.js";
import type { PdfAnnotations } from "../src/services/projects/pdf-annotations.js";
import type { ProjectService } from "../src/services/projects/project-service.js";

test("a dismissed finding is hidden from the audit and listed in USER_NOTES.md until restored", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "gali-dismiss-"));
  const projectDir = path.join(root, "project");
  await fsp.mkdir(projectDir);
  const documents = createReviewDocuments({
    projects: { dir: () => projectDir, getRow: async () => ({ paperPath: "paper/p.pdf" }) } as unknown as ProjectService,
    pdfAnnotations: { locateMany: async () => [] } as unknown as PdfAnnotations,
    snapshotsRoot: path.join(root, "snapshots"),
    dismissalsRoot: path.join(root, "dismissals"),
  });
  const write = (ids: string[]) => fsp.writeFile(path.join(projectDir, "review.json"), JSON.stringify({
    title: "Review",
    summary: "Summary.",
    findings: ids.map((id) => ({ id, severity: "minor", title: `Title ${id}`, body: `Body ${id}.` })),
  }));
  const notesPath = path.join(projectDir, "USER_NOTES.md");

  await write(["f1", "f2"]);
  await documents.accept("p");
  const dismissed = await documents.dismiss("p", "f2");
  expect(dismissed.dismissed).toEqual([expect.objectContaining({ id: "f2", title: "Title f2", body: "Body f2." })]);
  expect(await fsp.readFile(notesPath, "utf8")).toContain("- f2 · Title f2: Body f2.");

  await write(["f1"]);
  expect(await documents.audit("p")).toEqual([]);
  await expect(documents.dismiss("p", "f9")).rejects.toThrow("no finding f9 in the review");

  await write(["f1", "f2"]);
  expect((await documents.restore("p", "f2"))?.dismissed).toEqual([]);
  await expect(fsp.stat(notesPath)).rejects.toThrow();
  await expect(documents.restore("p", "f2")).rejects.toThrow("finding f2 is not dismissed");
});

test("a review keeps its well-formed parts and names every malformed one", () => {
  const parsed = parseReviewDocument({
    title: "Review",
    summary: "Summary.",
    findings: [
      {
        id: "f1",
        severity: "serious",
        title: "Mismatch",
        body: "Body.",
        refs: [
          { paper: { page: 5, quote: "exact words" } },
          { paper: { page: 0, quote: "bad page" } },
          { code: { path: "./code/a.py", lines: [3] } },
          { url: "https://example.com" },
        ],
        visuals: [
          { chart: { kind: "line", caption: "c", x: { label: "step", values: [0, 1] }, series: [{ name: "a", values: [1] }] } },
          { table: { caption: "t", columns: ["a", "b"], rows: [["1", 0.25]] } },
          { html: "<script>alert(1)</script>" },
        ],
      },
      { id: "f1", severity: "minor", title: "Duplicate", body: "Body." },
      { id: "f3", severity: "fatal", title: "Bad severity", body: "Body." },
    ],
    openQuestions: ["Which seed?", 3],
  });

  expect(parsed.document).toEqual({
    title: "Review",
    findings: [{
      id: "f1",
      severity: "serious",
      title: "Mismatch",
      body: "Body.",
      refs: [{ paper: { page: 5, quote: "exact words" } }, { code: { path: "code/a.py", lines: [3, 3] } }],
      visuals: [{ table: { caption: "t", columns: ["a", "b"], rows: [["1", "0.25"]] } }],
    }],
  });
  expect(parsed.problems).toEqual([
    "f1 ref 2: a paper ref needs page (a number from 1) and quote (exact text from that page)",
    "f1 ref 4: a ref is either {\"paper\": …} or {\"code\": …}",
    "f1 visual 1: a chart needs kind (line or bar), caption, x {label, values}, and 1–6 series {name, values} with one number per x value",
    "f1 visual 3: a visual is {\"figure\": …}, {\"chart\": …}, or {\"table\": …}",
    "finding 2: id \"f1\" is used twice",
    "finding 3 needs id, severity (serious, minor, ok, study), title, and body",
  ]);
});

test("a practice problem is kept as a study finding", () => {
  const study = {
    id: "s1",
    severity: "study",
    title: "Compute the group weights after one update",
    body: "Losses are 1 and 2. Find the weights. Solution: 0.475 and 0.525.",
    refs: [{ paper: { page: 5, quote: "exact words" } }],
    visuals: [{ table: { caption: "Steps", columns: ["step", "value"], rows: [["exp(0.1)", 1.105]] } }],
  };
  const parsed = parseReviewDocument({ title: "Review", findings: [study] });
  expect(parsed.problems).toEqual([]);
  expect(parsed.document?.findings).toEqual([{ ...study, visuals: [{ table: { caption: "Steps", columns: ["step", "value"], rows: [["exp(0.1)", "1.105"]] } }] }]);
});

test("a paper ref keeps the place the reviewer names, and a bad place is reported without losing the ref", () => {
  const parsed = parseReviewDocument({
    title: "Review",
    findings: [{
      id: "f1",
      severity: "minor",
      title: "T",
      body: "B.",
      refs: [
        { paper: { page: 3, place: "§3.2 Clustering", quote: "exact words" } },
        { paper: { page: 5, place: "x".repeat(61), quote: "other words" } },
      ],
    }],
  });
  expect(parsed.document?.findings[0]?.refs).toEqual([
    { paper: { page: 3, quote: "exact words", place: "§3.2 Clustering" } },
    { paper: { page: 5, quote: "other words" } },
  ]);
  expect(parsed.problems).toEqual([
    "f1 ref 2: place is a short name from the paper, like \"§3.2 Clustering\" or \"Table 2\" (at most 60 characters)",
  ]);
});

test("a review without a title is not shown", () => {
  expect(parseReviewDocument({ findings: [] })).toEqual({ document: null, problems: ["review.json needs a title"] });
  expect(parseReviewDocument([1, 2])).toEqual({ document: null, problems: ["review.json must be a JSON object"] });
});
