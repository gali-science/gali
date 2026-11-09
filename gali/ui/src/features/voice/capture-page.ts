import { getFontEmbedCSS, toPng } from "html-to-image";

let fontEmbedCssPromise: Promise<string> | null = null;

function fontEmbedCss(root: HTMLElement): Promise<string> {
  if (!fontEmbedCssPromise) {
    fontEmbedCssPromise = getFontEmbedCSS(root).catch(() => {
      fontEmbedCssPromise = null;
      return "";
    });
  }
  return fontEmbedCssPromise;
}

export type WindowCapture = {
  pngBase64: string;
  width: number;
  height: number;
};

export function captureErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  if (typeof Event !== "undefined" && err instanceof Event) {
    return "Couldn't capture the page (an image failed to load). Try again.";
  }
  return "Couldn't capture the page. Try again.";
}

async function blobUrlToDataUrl(src: string): Promise<string> {
  const res = await fetch(src);
  const blob = await res.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const mime = blob.type || "application/octet-stream";
  return `data:${mime};base64,${btoa(binary)}`;
}

let captureCount = 0;

// Cloned nodes lose scrollTop/scrollLeft, so scrolled content is shifted in the snapshot's
// own stylesheet; moving the live scroll instead would fight the user's scrolling.
function markScrolledContent(root: HTMLElement): { css: string; unmark: () => void } {
  const attribute = `data-gali-capture-${++captureCount}`;
  const rules: string[] = [];
  const marked: HTMLElement[] = [];
  const scrolled = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))].filter(
    (el) => el.scrollTop > 0 || el.scrollLeft > 0,
  );
  for (const el of scrolled) {
    for (const child of Array.from(el.children)) {
      if (!(child instanceof HTMLElement)) continue;
      const computed = getComputedStyle(child).transform;
      child.setAttribute(attribute, String(marked.length));
      rules.push(`[${attribute}="${marked.length}"]{transform:translate(${-el.scrollLeft}px, ${-el.scrollTop}px)${
        computed && computed !== "none" ? ` ${computed}` : ""
      } !important}`);
      marked.push(child);
    }
  }
  return {
    css: rules.join("\n"),
    unmark: () => {
      for (const child of marked) child.removeAttribute(attribute);
    },
  };
}

function loadedImageToDataUrl(img: HTMLImageElement): string | null {
  if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl.startsWith("data:image/") ? dataUrl : null;
  } catch {
    return null;
  }
}

const IMAGE_LOAD_TIMEOUT_MS = 1000;

function blobSrc(img: HTMLImageElement): string | null {
  const src = img.currentSrc || img.src;
  return src.startsWith("blob:") ? src : null;
}

function imageSettled(img: HTMLImageElement): Promise<void> {
  if (img.complete) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener("load", () => resolve(), { once: true });
    img.addEventListener("error", () => resolve(), { once: true });
  });
}

async function imagesSettled(imgs: HTMLImageElement[]): Promise<void> {
  if (imgs.length === 0) return;
  await Promise.race([
    Promise.all(imgs.map(imageSettled)),
    new Promise((resolve) => window.setTimeout(resolve, IMAGE_LOAD_TIMEOUT_MS)),
  ]);
  // Let pending load handlers run first: the PDF viewer frees a tile's blob URL in onLoad.
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

function isBlobImage(node: Node): boolean {
  return node instanceof HTMLImageElement && (node.getAttribute("src") ?? "").startsWith("blob:");
}

async function withInlinedBlobImages<T>(
  root: HTMLElement,
  run: (inlined: HTMLImageElement[]) => Promise<T>,
): Promise<T> {
  const imgs = Array.from(root.querySelectorAll("img")).filter((img) => blobSrc(img) !== null);
  await imagesSettled(imgs);
  const restores: Array<() => void> = [];
  const inlined: HTMLImageElement[] = [];
  try {
    await Promise.all(
      imgs.map(async (img) => {
        const src = blobSrc(img);
        if (!src || !img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
        const previous = img.getAttribute("src");
        const fetched = await blobUrlToDataUrl(src).catch(() => null);
        if (fetched) {
          img.setAttribute("src", fetched);
          inlined.push(img);
          restores.push(() => {
            if (previous === null) img.removeAttribute("src");
            else img.setAttribute("src", previous);
          });
          return;
        }
        // The blob URL is already freed, so pointing the image back at it would break it on screen.
        const copied = loadedImageToDataUrl(img);
        if (copied) {
          img.setAttribute("src", copied);
          inlined.push(img);
        }
      }),
    );
    return await run(inlined);
  } finally {
    for (const restore of restores) restore();
  }
}

// WebKit does not paint images inside the SVG foreignObject the snapshot is drawn in.
function paintsImagesInSnapshot(): boolean {
  return typeof (window as { GestureEvent?: unknown }).GestureEvent !== "function";
}

function visibleRect(img: HTMLImageElement, root: HTMLElement): { left: number; top: number; width: number; height: number } {
  let { left, top, right, bottom } = img.getBoundingClientRect();
  for (let el = img.parentElement; el; el = el.parentElement) {
    const style = getComputedStyle(el);
    if (el === root || style.overflowX !== "visible" || style.overflowY !== "visible") {
      const box = el.getBoundingClientRect();
      left = Math.max(left, box.left);
      top = Math.max(top, box.top);
      right = Math.min(right, box.right);
      bottom = Math.min(bottom, box.bottom);
    }
    if (el === root) break;
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

async function paintImagesOver(
  dataUrl: string,
  imgs: HTMLImageElement[],
  root: HTMLElement,
  scale: number,
): Promise<string> {
  const shot = new Image();
  shot.src = dataUrl;
  await shot.decode();
  const canvas = document.createElement("canvas");
  canvas.width = shot.naturalWidth;
  canvas.height = shot.naturalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("browser capture could not draw the page images");
  ctx.drawImage(shot, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  const origin = root.getBoundingClientRect();
  for (const img of imgs) {
    await img.decode().catch(() => undefined);
    if (!img.complete || img.naturalWidth <= 0) continue;
    const view = visibleRect(img, root);
    if (view.width <= 0 || view.height <= 0) continue;
    const box = img.getBoundingClientRect();
    ctx.save();
    ctx.beginPath();
    ctx.rect((view.left - origin.left) * scale, (view.top - origin.top) * scale, view.width * scale, view.height * scale);
    ctx.clip();
    ctx.drawImage(img, (box.left - origin.left) * scale, (box.top - origin.top) * scale, box.width * scale, box.height * scale);
    ctx.restore();
  }
  return canvas.toDataURL("image/png");
}

async function withInlinedCanvases<T>(
  root: HTMLElement,
  run: () => Promise<T>,
): Promise<T> {
  const canvases = Array.from(root.querySelectorAll("canvas"));
  const restores: Array<() => void> = [];
  try {
    for (const canvas of canvases) {
      if (canvas.width <= 0 || canvas.height <= 0) continue;
      const dataUrl = canvas.toDataURL("image/png");
      if (!dataUrl.startsWith("data:image/")) continue;
      const img = document.createElement("img");
      img.className = canvas.className;
      img.src = dataUrl;
      img.style.cssText = canvas.style.cssText;
      img.style.width = `${canvas.offsetWidth}px`;
      img.style.height = `${canvas.offsetHeight}px`;
      canvas.replaceWith(img);
      restores.push(() => img.replaceWith(canvas));
    }
    return await run();
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

export async function captureBrowserPage(
  root: HTMLElement = document.getElementById("root") ?? document.body,
): Promise<WindowCapture> {
  const width = Math.max(1, root.clientWidth || window.innerWidth);
  const height = Math.max(1, root.clientHeight || window.innerHeight);
  const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
  try {
    const fontCss = await fontEmbedCss(root);
    return await withInlinedBlobImages(root, (inlined) =>
      withInlinedCanvases(root, async () => {
        const scroll = markScrolledContent(root);
        let dataUrl: string;
        try {
          const css = [fontCss, scroll.css].filter(Boolean).join("\n");
          dataUrl = await toPng(root, {
            width,
            height,
            pixelRatio,
            cacheBust: false,
            // skipFonts renders the snapshot in system fonts; only when embedding failed.
            ...(css ? { fontEmbedCSS: css } : { skipFonts: true }),
            onImageErrorHandler: () => undefined,
            filter: (node) => !isBlobImage(node),
          });
        } finally {
          scroll.unmark();
        }
        if (!paintsImagesInSnapshot() && inlined.length > 0) {
          dataUrl = await paintImagesOver(dataUrl, inlined, root, pixelRatio);
        }
        const prefix = "data:image/png;base64,";
        if (!dataUrl.startsWith(prefix)) {
          throw new Error("browser capture did not return a PNG data URL");
        }
        return {
          pngBase64: dataUrl.slice(prefix.length),
          width: Math.max(1, Math.round(width * pixelRatio)),
          height: Math.max(1, Math.round(height * pixelRatio)),
        };
      }),
    );
  } catch (err) {
    throw new Error(captureErrorMessage(err), { cause: err });
  }
}
