import { expect, test } from "vitest";
import { lumaStddev, canvasesLookEmpty, pdfPageImage } from "./view-capture";

function rgba(fill: (i: number) => [number, number, number, number], n = 64): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b, a] = fill(i);
    pixels.set([r, g, b, a], i * 4);
  }
  return pixels;
}

test("uniform pixels look empty", () => {
  expect(lumaStddev(rgba(() => [255, 255, 255, 255]))).toBeLessThan(8);
});

test("mixed pixels do not look empty", () => {
  expect(lumaStddev(rgba((i) => (i % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])))).toBeGreaterThan(8);
});

test("a zero-size canvas counts as empty; no canvas does not", () => {
  const root = document.createElement("div");
  expect(canvasesLookEmpty(root)).toBe(false);
  const canvas = document.createElement("canvas");
  canvas.width = 0;
  canvas.height = 0;
  root.appendChild(canvas);
  expect(canvasesLookEmpty(root)).toBe(true);
});

// The PDF renderer paints <img>, not <canvas>. Without this the check finds
// nothing, reports "not empty", and blank pages reach the model as captures.
test("an unpainted pdf page image counts as empty", () => {
  const root = document.createElement("div");
  const image = document.createElement("img");
  image.className = "source-file-pdf-page-sheet";
  root.appendChild(image);
  expect(canvasesLookEmpty(root)).toBe(true);
});

test("an image that is not a pdf page is ignored", () => {
  const root = document.createElement("div");
  root.appendChild(document.createElement("img"));
  expect(canvasesLookEmpty(root)).toBe(false);
});

function pdfTile(page: string, withImage: boolean): { root: HTMLElement; img: HTMLImageElement | null } {
  const root = document.createElement("div");
  root.dataset.tilePage = page;
  const pageEl = document.createElement("div");
  pageEl.className = "tile-viewer-pdf-page";
  pageEl.setAttribute("data-page", page);
  root.appendChild(pageEl);
  let img: HTMLImageElement | null = null;
  if (withImage) {
    img = document.createElement("img");
    img.className = "source-file-pdf-page-sheet";
    pageEl.appendChild(img);
  }
  return { root, img };
}

test("the requested pdf page's image is found once it has mounted", () => {
  expect(pdfPageImage(pdfTile("16", false).root, "16")).toBeNull();
  const { root, img } = pdfTile("16", true);
  expect(pdfPageImage(root, "16")).toBe(img);
});

test("without a requested page the viewer's own page is used, and other pages do not match", () => {
  const { root, img } = pdfTile("16", true);
  expect(pdfPageImage(root, undefined)).toBe(img);
  expect(pdfPageImage(root, "15")).toBeNull();
});
