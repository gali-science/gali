export type Point = { x: number; y: number };

export type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LookImage = {
  mime: "image/jpeg";
  base64: string;
};

// One WebRTC data channel message; payloads near the ~256 KB browser limit kill the channel silently (openai-agents-js#501).
export const LOOK_MAX_SIDE = 1024;
export const LOOK_MAX_BASE64_CHARS = 220_000;
export const LOOK_SIDE_STEPS = [1024, 768, 512];
export const LOOK_QUALITY_STEPS = [0.8, 0.55];

export function normalizeSelectionRect(
  start: Point,
  end: Point,
  bounds: { width: number; height: number },
  minSize = 8,
): SelectionRect | null {
  const left = Math.max(0, Math.min(start.x, end.x));
  const top = Math.max(0, Math.min(start.y, end.y));
  const right = Math.min(bounds.width, Math.max(start.x, end.x));
  const bottom = Math.min(bounds.height, Math.max(start.y, end.y));
  const width = right - left;
  const height = bottom - top;
  if (width < minSize || height < minSize) return null;
  return { x: left, y: top, width, height };
}

export function mapDisplayRectToImage(
  rect: SelectionRect,
  display: { width: number; height: number },
  image: { width: number; height: number },
): SelectionRect {
  if (display.width <= 0 || display.height <= 0) {
    throw new Error("display size unavailable");
  }
  const scaleX = image.width / display.width;
  const scaleY = image.height / display.height;
  let x = Math.round(rect.x * scaleX);
  let y = Math.round(rect.y * scaleY);
  let width = Math.max(1, Math.round(rect.width * scaleX));
  let height = Math.max(1, Math.round(rect.height * scaleY));
  x = Math.max(0, Math.min(x, Math.max(0, image.width - 1)));
  y = Math.max(0, Math.min(y, Math.max(0, image.height - 1)));
  width = Math.max(1, Math.min(width, image.width - x));
  height = Math.max(1, Math.min(height, image.height - y));
  return { x, y, width, height };
}

export function fitLookDimensions(
  width: number,
  height: number,
  maxSide = LOOK_MAX_SIDE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width, height };
  const scale = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export async function cropAndPrepareLookImage(
  pngBase64: string,
  rect: SelectionRect,
): Promise<LookImage> {
  const image = await loadImage(`data:image/png;base64,${pngBase64}`);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");

  for (const maxSide of LOOK_SIDE_STEPS) {
    const fitted = fitLookDimensions(rect.width, rect.height, maxSide);
    canvas.width = fitted.width;
    canvas.height = fitted.height;
    ctx.drawImage(
      image,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      fitted.width,
      fitted.height,
    );
    for (const quality of LOOK_QUALITY_STEPS) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      const prefix = "data:image/jpeg;base64,";
      if (!dataUrl.startsWith(prefix)) throw new Error("unexpected canvas output");
      const base64 = dataUrl.slice(prefix.length);
      if (base64.length <= LOOK_MAX_BASE64_CHARS) {
        return { mime: "image/jpeg", base64 };
      }
    }
  }
  throw new Error("region too large — select a smaller area");
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("failed to decode capture"));
    image.src = url;
  });
}
