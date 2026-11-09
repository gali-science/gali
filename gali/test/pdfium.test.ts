import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { withPdfDocument } from "../src/services/projects/pdfium.js";

const PAPER = fs.readFileSync(path.join(import.meta.dirname, "fixtures/ctc-dro.pdf"));
const RGB = [255, 214, 10] as const;

test("pages are 1-based and out-of-range pages fail with the valid range", async () => {
  await withPdfDocument(PAPER, (doc) => {
    expect(doc.page(1, (page) => ({ number: page.number, width: page.width, height: page.height })))
      .toEqual({ number: 1, width: 612, height: 792 });
    expect(() => doc.page(0, () => null)).toThrow(`page 0 is out of range (1–${doc.pageCount})`);
    expect(() => doc.page(doc.pageCount + 1, () => null)).toThrow("out of range");
  });
});

test("text boxes come back top-left origin, inside the page", async () => {
  await withPdfDocument(PAPER, (doc) => doc.page(1, (page) => {
    const start = page.text().indexOf("Published");
    const [box] = page.textRects(start, "Published".length);
    expect(box!.x).toBeGreaterThan(0);
    expect(box!.y).toBeLessThan(page.height / 4);
    expect(box!.width).toBeGreaterThan(0);
  }));
});

test("written annotations survive save and reopen; an empty highlight is refused", async () => {
  const saved = await withPdfDocument(PAPER, (doc) => {
    doc.page(2, (page) => {
      page.addHighlight({ rects: [{ x: 100, y: 100, width: 200, height: 12 }], rgb: RGB, author: "Gali", contents: "1. ünïcode “note”" });
      page.addNote({ rect: { x: 560, y: 18, width: 18, height: 18 }, rgb: RGB, author: "Gali", contents: "2." });
      expect(() => page.addHighlight({ rects: [], rgb: RGB, author: "Gali", contents: "" }))
        .toThrow("a highlight needs at least one rect");
    });
    return doc.save();
  });

  const reopened = await withPdfDocument(saved, (doc) =>
    doc.page(2, (page) => page.annotations().filter((annotation) => annotation.kind !== "link"))
  );
  expect(reopened).toEqual([
    { kind: "highlight", contents: "1. ünïcode “note”" },
    { kind: "note", contents: "2." },
  ]);
});
