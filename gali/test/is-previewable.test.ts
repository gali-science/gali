import { expect, test } from "vitest";
import { isPreviewable, previewProblem, viewerDisplay } from "../src/adapters/fs/project-files.js";

test("viewer-renderable formats are previewable", () => {
  for (const file of [
    "notes.md",
    "src/app.py",
    "data/results.csv",
    "figures/plot.svg",
    "figures/plot.png",
    "paper.pdf",
    "clips/demo.mp4",
    "clips/talk.mp3",
  ]) {
    expect(isPreviewable(file), file).toBe(true);
  }
});

test("well-known extensionless text files are previewable", () => {
  for (const file of [
    "Makefile",
    "Dockerfile",
    "LICENSE",
    "README",
    "docs/CHANGELOG",
    ".gitignore",
    ".editorconfig",
  ]) {
    expect(isPreviewable(file), file).toBe(true);
  }
});

test("formats the viewer refuses are not previewable", () => {
  for (const file of [
    "deck.pptx",
    "deck.PPTX",
    "report.docx",
    "sheet.xlsx",
    "photo.heic",
    "scan.tiff",
    "clip.avi",
    "clip.mkv",
    "data/results.parquet",
    "archive.zip",
    "bin/tool",
  ]) {
    expect(isPreviewable(file), file).toBe(false);
    expect(previewProblem(file, 100), file).toBe("unsupported");
  }
});

test("viewable media over the display limit reports too-large", () => {
  for (const file of ["huge.png", "huge.pdf", "huge.mp4", "huge.mp3"]) {
    expect(previewProblem(file, 100), file).toBe(null);
    expect(previewProblem(file, 10 ** 12), file).toBe("too-large");
    expect(isPreviewable(file, 10 ** 12), file).toBe(false);
  }
});

test("svg uses the text read limit, not the image limit", () => {
  expect(previewProblem("figures/plot.svg", 1_000)).toBe(null);
  expect(previewProblem("figures/plot.svg", 300_000)).toBe("too-large");
});

test("viewerDisplay reports what the viewer shows for every file state", () => {
  expect(viewerDisplay("notes.md", 1_000)).toBe("full");
  expect(viewerDisplay("figures/plot.png", 1_000)).toBe("full");
  expect(viewerDisplay("run.log", 300_000)).toBe("truncated");
  expect(viewerDisplay("data/results.csv", 300_000)).toBe("truncated");
  expect(viewerDisplay("deck.pptx", 100)).toBe("no-preview");
  expect(viewerDisplay("photo.heic", 100)).toBe("no-preview");
  expect(viewerDisplay("huge.png", 10 ** 12)).toBe("too-large");
  expect(viewerDisplay("figures/plot.svg", 300_000)).toBe("too-large");
});
