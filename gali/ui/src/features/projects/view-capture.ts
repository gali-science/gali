import type { LookCaptureResult, TileCaptureTarget } from "../../realtime-client";
import { findViewElement } from "../../realtime/tile-view-sync";
import { captureBrowserPage, captureErrorMessage } from "../voice/capture-page";
import { cropAndPrepareLookImage, fitLookDimensions } from "../voice/selection-rect";

export type TileViewState = "loading" | "ready" | "av";

const POLL_MS = 120;
const EMPTY_LUMA_STDDEV = 8;
const CAPTURE_ATTEMPTS = 3;
const RETRY_MS = 200;

export function lumaStddev(pixels: Uint8ClampedArray): number {
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i + 2 < pixels.length; i += 4) {
    const y = 0.299 * pixels[i]! + 0.587 * pixels[i + 1]! + 0.114 * pixels[i + 2]!;
    sum += y;
    sumSq += y * y;
    n += 1;
  }
  if (n < 2) return 0;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sumSq / n - mean * mean));
}

async function pngLumaStddev(pngBase64: string): Promise<number> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to decode capture"));
    img.src = `data:image/png;base64,${pngBase64}`;
  });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, image.width);
  canvas.height = Math.max(1, image.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.drawImage(image, 0, 0);
  return lumaStddev(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

/**
 * The PDF renderer paints page images, not canvases. Scoped to the page class so
 * an ordinary image tile is still judged by the whole-capture luma check alone —
 * a legitimately near-white photo must not read as a failed render.
 */
const PDF_PAGE_IMAGE_SELECTOR = "img.source-file-pdf-page-sheet";

function imageLumaStddev(image: HTMLImageElement): number {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return 0;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  ctx.drawImage(image, 0, 0);
  return lumaStddev(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
}

export function canvasesLookEmpty(root: HTMLElement): boolean {
  const spreads: number[] = [];
  for (const canvas of root.querySelectorAll("canvas")) {
    if (canvas.width <= 0 || canvas.height <= 0) {
      spreads.push(0);
      continue;
    }
    const ctx = canvas.getContext("2d");
    spreads.push(
      ctx ? lumaStddev(ctx.getImageData(0, 0, canvas.width, canvas.height).data) : 0,
    );
  }
  for (const image of root.querySelectorAll<HTMLImageElement>(PDF_PAGE_IMAGE_SELECTOR)) {
    spreads.push(imageLumaStddev(image));
  }
  // Nothing rendered here at all, so this check has no opinion.
  if (spreads.length === 0) return false;
  return spreads.every((spread) => spread < EMPTY_LUMA_STDDEV);
}

const PDF_PAGE_SELECTOR = ".tile-viewer-pdf-page";

function isPdfTile(el: HTMLElement): boolean {
  return el.querySelector(PDF_PAGE_SELECTOR) !== null;
}

/**
 * The image element of the requested PDF page, or of the page the viewer is on
 * when none was requested. A page mounts its image only once pdfium has drawn
 * it, so null means the page is still white.
 */
export function pdfPageImage(el: HTMLElement, page: string | undefined): HTMLImageElement | null {
  const number = page ?? el.dataset.tilePage;
  if (number === undefined || number === "") return null;
  return el.querySelector<HTMLImageElement>(
    `${PDF_PAGE_SELECTOR}[data-page="${number}"] ${PDF_PAGE_IMAGE_SELECTOR}`,
  );
}

function imageIsDrawn(image: HTMLImageElement | null): image is HTMLImageElement {
  return image !== null && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
}

/**
 * Copies a drawn PDF page straight off its image element. Screenshotting the
 * viewer instead scrolls it to the top for the clone, which makes EmbedPDF
 * unmount the page and report page 1 — a blank capture and a jump back to the
 * start. Reading the image touches nothing. Sized for the model up front so
 * the canvas stays small.
 */
function copyPdfPage(
  image: HTMLImageElement,
): { pngBase64: string; width: number; height: number; luma: number } | null {
  const { width, height } = fitLookDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  try {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const luma = lumaStddev(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
    const dataUrl = canvas.toDataURL("image/png");
    const prefix = "data:image/png;base64,";
    if (!dataUrl.startsWith(prefix)) return null;
    return { pngBase64: dataUrl.slice(prefix.length), width: canvas.width, height: canvas.height, luma };
  } catch {
    return null;
  }
}

async function waitForTileReady(
  target: TileCaptureTarget,
  timeoutMs: number,
): Promise<{ el: HTMLElement } | { error: string }> {
  const deadline = performance.now() + timeoutMs;
  const expectedPage = target.page === undefined ? undefined : String(target.page);
  for (;;) {
    const el = findViewElement(target.path);
    const pageOk = expectedPage === undefined || el?.dataset.tilePage === expectedPage;
    if (el && pageOk) {
      const state = el.dataset.tileReady as TileViewState | undefined;
      if (state === "ready" && (!isPdfTile(el) || imageIsDrawn(pdfPageImage(el, expectedPage)))) {
        return { el };
      }
      if (state === "av") {
        return {
          error:
            "this is an audio/video file — it is playable on screen but its content cannot be captured as an image",
        };
      }
    }
    if (performance.now() > deadline) {
      return {
        error: el
          ? "the viewer did not finish rendering in time"
          : "the viewer is not open",
      };
    }
    await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
  }
}

export async function captureTileView(
  target: TileCaptureTarget,
  timeoutMs = 4_000,
): Promise<LookCaptureResult> {
  try {
    const waited = await waitForTileReady(target, timeoutMs);
    if ("error" in waited) return { status: "failed", error: waited.error };
    const expectedPage = target.page === undefined ? undefined : String(target.page);
    let empty = false;
    for (let attempt = 0; attempt < CAPTURE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, RETRY_MS));
      }
      const el = findViewElement(target.path) ?? waited.el;
      if (isPdfTile(el)) {
        const pageImage = pdfPageImage(el, expectedPage);
        const copied = imageIsDrawn(pageImage) ? copyPdfPage(pageImage) : null;
        if (copied === null || copied.luma < EMPTY_LUMA_STDDEV) {
          empty = true;
          continue;
        }
        const image = await cropAndPrepareLookImage(copied.pngBase64, {
          x: 0,
          y: 0,
          width: copied.width,
          height: copied.height,
        });
        return { status: "captured", mime: image.mime, base64: image.base64 };
      }
      const shot = await captureBrowserPage(el);
      const blankCanvas = canvasesLookEmpty(el);
      if (blankCanvas || (await pngLumaStddev(shot.pngBase64)) < EMPTY_LUMA_STDDEV) {
        empty = true;
        continue;
      }
      const image = await cropAndPrepareLookImage(shot.pngBase64, {
        x: 0,
        y: 0,
        width: shot.width,
        height: shot.height,
      });
      return { status: "captured", mime: image.mime, base64: image.base64 };
    }
    return {
      status: "failed",
      error: empty ? "the capture was empty" : "the viewer did not finish rendering in time",
    };
  } catch (err) {
    return { status: "failed", error: captureErrorMessage(err) };
  }
}
