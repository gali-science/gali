import { beforeEach, expect, test, vi } from "vitest";

const toPng = vi.fn();
const getFontEmbedCSS = vi.fn();

vi.mock("html-to-image", () => ({
  toPng: (...args: unknown[]) => toPng(...args),
  getFontEmbedCSS: (...args: unknown[]) => getFontEmbedCSS(...args),
}));

beforeEach(() => {
  toPng.mockReset();
  getFontEmbedCSS.mockReset();
  getFontEmbedCSS.mockResolvedValue("@font-face{font-family:Test}");
});

test("captureBrowserPage returns png bytes and scaled size", async () => {
  const pngBase64 = "abc123";
  toPng.mockResolvedValue(`data:image/png;base64,${pngBase64}`);
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });

  const { captureBrowserPage } = await import("./capture-page");
  const root = document.createElement("div");
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });

  const shot = await captureBrowserPage(root);
  expect(shot.pngBase64).toBe(pngBase64);
  expect(shot.width).toBe(200);
  expect(shot.height).toBe(100);
  expect(toPng).toHaveBeenCalledOnce();
  expect(toPng.mock.calls[0]?.[1]).toMatchObject({
    fontEmbedCSS: "@font-face{font-family:Test}",
    cacheBust: false,
    onImageErrorHandler: expect.any(Function),
  });
});

test("captureBrowserPage skips fonts when embedding fails", async () => {
  vi.resetModules();
  getFontEmbedCSS.mockRejectedValue(new Error("no css access"));
  toPng.mockResolvedValue("data:image/png;base64,abc123");
  const { captureBrowserPage } = await import("./capture-page");
  const root = document.createElement("div");
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });
  await captureBrowserPage(root);
  expect(toPng.mock.calls[0]?.[1]).toMatchObject({ skipFonts: true });
});

test("captureBrowserPage maps Event rejections to a readable error", async () => {
  toPng.mockRejectedValue(new Event("error"));
  const { captureBrowserPage, captureErrorMessage } = await import("./capture-page");
  const root = document.createElement("div");
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });
  await expect(captureBrowserPage(root)).rejects.toThrow(
    /Couldn't capture the page/,
  );
  expect(captureErrorMessage(new Event("error"))).toMatch(/image failed to load/i);
});

test("captureBrowserPage inlines blob images before toPng and restores after", async () => {
  toPng.mockImplementation(async (root: HTMLElement) => {
    const img = root.querySelector("img");
    expect(img?.getAttribute("src")?.startsWith("data:image/")).toBe(true);
    return "data:image/png;base64,abc123";
  });
  const bytes = new Uint8Array([137, 80, 78, 71]);
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
  const root = document.createElement("div");
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });
  const img = document.createElement("img");
  img.setAttribute("src", blobUrl);
  Object.defineProperty(img, "complete", { value: true });
  Object.defineProperty(img, "naturalWidth", { value: 4 });
  Object.defineProperty(img, "naturalHeight", { value: 3 });
  root.appendChild(img);
  const { captureBrowserPage } = await import("./capture-page");
  const shot = await captureBrowserPage(root);
  expect(shot.pngBase64).toBe("abc123");
  expect(img.getAttribute("src")).toBe(blobUrl);
  URL.revokeObjectURL(blobUrl);
});

test("captureBrowserPage keeps the copy on a PDF tile whose blob URL was freed, so the live tile stays drawn", async () => {
  const copied = "data:image/png;base64,Q09QWQ==";
  const drawImage = vi.fn();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(copied);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const released = "blob:http://localhost/released-page";
  toPng.mockImplementation(async (root: HTMLElement) => {
    expect(root.querySelector("img")?.getAttribute("src")).toBe(copied);
    return "data:image/png;base64,abc123";
  });
  const root = document.createElement("div");
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });
  const img = document.createElement("img");
  img.setAttribute("src", released);
  Object.defineProperty(img, "complete", { value: true });
  Object.defineProperty(img, "naturalWidth", { value: 4 });
  Object.defineProperty(img, "naturalHeight", { value: 3 });
  root.appendChild(img);
  const { captureBrowserPage } = await import("./capture-page");
  try {
    const shot = await captureBrowserPage(root);
    expect(shot.pngBase64).toBe("abc123");
    expect(fetchSpy).toHaveBeenCalledWith(released);
    expect(drawImage).toHaveBeenCalledWith(img, 0, 0);
    expect(img.getAttribute("src")).toBe(copied);
  } finally {
    getContext.mockRestore();
    toDataURL.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("captureBrowserPage leaves a broken blob image out of the snapshot instead of failing the capture", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  const released = "blob:http://localhost/released-page";
  let filter: ((node: Node) => boolean) | undefined;
  toPng.mockImplementation(async (_root: HTMLElement, options: { filter: (node: Node) => boolean }) => {
    filter = options.filter;
    return "data:image/png;base64,abc123";
  });
  const root = document.createElement("div");
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });
  const img = document.createElement("img");
  img.setAttribute("src", released);
  Object.defineProperty(img, "complete", { value: true });
  Object.defineProperty(img, "naturalWidth", { value: 0 });
  root.appendChild(img);
  const drawn = document.createElement("img");
  drawn.setAttribute("src", "data:image/png;base64,QQ==");
  const { captureBrowserPage } = await import("./capture-page");
  try {
    const shot = await captureBrowserPage(root);
    expect(shot.pngBase64).toBe("abc123");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(filter?.(img)).toBe(false);
    expect(filter?.(drawn)).toBe(true);
    expect(filter?.(document.createElement("div"))).toBe(true);
    expect(img.getAttribute("src")).toBe(released);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("captureBrowserPage waits for a PDF tile that is still loading before copying it", async () => {
  const copied = "data:image/png;base64,Q09QWQ==";
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(copied);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
  toPng.mockImplementation(async (root: HTMLElement) => {
    expect(root.querySelector("img")?.getAttribute("src")).toBe(copied);
    return "data:image/png;base64,abc123";
  });
  const root = document.createElement("div");
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });
  const img = document.createElement("img");
  img.setAttribute("src", "blob:http://localhost/loading-tile");
  let loaded = false;
  Object.defineProperty(img, "complete", { get: () => loaded });
  Object.defineProperty(img, "naturalWidth", { get: () => (loaded ? 4 : 0) });
  Object.defineProperty(img, "naturalHeight", { get: () => (loaded ? 3 : 0) });
  root.appendChild(img);
  window.setTimeout(() => {
    loaded = true;
    img.dispatchEvent(new Event("load"));
  }, 20);
  const { captureBrowserPage } = await import("./capture-page");
  try {
    await captureBrowserPage(root);
    expect(toPng).toHaveBeenCalledOnce();
    expect(img.getAttribute("src")).toBe(copied);
  } finally {
    getContext.mockRestore();
    toDataURL.mockRestore();
    fetchSpy.mockRestore();
  }
});

test("captureBrowserPage never moves the live scroll; the snapshot's own stylesheet shifts the scrolled content", async () => {
  const root = document.createElement("div");
  document.body.appendChild(root);
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });
  const viewport = document.createElement("div");
  const setScrollTop = vi.fn();
  Object.defineProperty(viewport, "scrollTop", { configurable: true, get: () => 240, set: setScrollTop });
  const content = document.createElement("div");
  viewport.appendChild(content);
  root.appendChild(viewport);
  toPng.mockImplementation(async (_root: HTMLElement, options: { fontEmbedCSS: string }) => {
    const marker = Array.from(content.attributes).find((attribute) => attribute.name.startsWith("data-gali-capture-"))!;
    expect(options.fontEmbedCSS).toContain("@font-face{font-family:Test}");
    expect(options.fontEmbedCSS).toContain(`[${marker.name}="${marker.value}"]{transform:translate(0px, -240px) !important}`);
    expect(content.style.transform).toBe("");
    return "data:image/png;base64,abc123";
  });
  const { captureBrowserPage } = await import("./capture-page");
  try {
    await captureBrowserPage(root);
    expect(toPng).toHaveBeenCalledOnce();
    expect(setScrollTop).not.toHaveBeenCalled();
    expect(Array.from(content.attributes).map((attribute) => attribute.name)).toEqual([]);
  } finally {
    root.remove();
  }
});

function pdfTileRoot() {
  const root = document.createElement("div");
  document.body.appendChild(root);
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });
  root.getBoundingClientRect = () => ({ left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50 }) as DOMRect;
  const viewer = document.createElement("div");
  viewer.style.overflowX = "auto";
  viewer.style.overflowY = "auto";
  viewer.getBoundingClientRect = () => ({ left: 10, top: 30, right: 110, bottom: 70, width: 100, height: 40 }) as DOMRect;
  const img = document.createElement("img");
  img.setAttribute("src", "blob:http://localhost/page-1");
  Object.defineProperty(img, "complete", { value: true });
  Object.defineProperty(img, "naturalWidth", { value: 40 });
  Object.defineProperty(img, "naturalHeight", { value: 60 });
  img.decode = () => Promise.resolve();
  img.getBoundingClientRect = () => ({ left: 20, top: 25, right: 60, bottom: 85, width: 40, height: 60 }) as DOMRect;
  viewer.appendChild(img);
  root.appendChild(viewer);
  return { root, img };
}

test("on Safari the PDF pages are drawn over the snapshot, cut to the part on screen", async () => {
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
  Object.defineProperty(window, "GestureEvent", { configurable: true, writable: true, value: function GestureEvent() {} });
  const calls: unknown[][] = [];
  const ctx = {
    globalCompositeOperation: "source-over",
    drawImage: (...args: unknown[]) => calls.push(["drawImage", ctx.globalCompositeOperation, ...args]),
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    rect: (...args: unknown[]) => calls.push(["rect", ...args]),
    clip: () => calls.push(["clip"]),
  };
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,UEFJTlRFRA==");
  Object.defineProperty(HTMLImageElement.prototype, "decode", { configurable: true, writable: true, value: () => Promise.resolve() });
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
  toPng.mockResolvedValue("data:image/png;base64,U05BUFNIT1Q=");
  const { root, img } = pdfTileRoot();
  const { captureBrowserPage } = await import("./capture-page");
  try {
    const shot = await captureBrowserPage(root);
    expect(shot.pngBase64).toBe("UEFJTlRFRA==");
    expect(calls[0]).toEqual(["drawImage", "source-over", expect.any(HTMLImageElement), 0, 0]);
    expect(calls.slice(1)).toEqual([
      ["rect", 20, 20, 80, 80],
      ["clip"],
      ["drawImage", "multiply", img, 20, 10, 80, 120],
    ]);
    expect(img.getAttribute("src")).toBe("blob:http://localhost/page-1");
  } finally {
    Reflect.deleteProperty(window, "GestureEvent");
    getContext.mockRestore();
    toDataURL.mockRestore();
    Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
    fetchSpy.mockRestore();
    root.remove();
  }
});

test("outside Safari the snapshot is returned as drawn, with nothing painted over it", async () => {
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext");
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1]), { headers: { "content-type": "image/png" } }));
  toPng.mockResolvedValue("data:image/png;base64,U05BUFNIT1Q=");
  const { root } = pdfTileRoot();
  const { captureBrowserPage } = await import("./capture-page");
  try {
    const shot = await captureBrowserPage(root);
    expect(shot.pngBase64).toBe("U05BUFNIT1Q=");
    expect(getContext).not.toHaveBeenCalled();
  } finally {
    getContext.mockRestore();
    fetchSpy.mockRestore();
    root.remove();
  }
});

test("captureBrowserPage inlines canvases before toPng and restores after", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,QQ==");
  toPng.mockImplementation(async (root: HTMLElement) => {
    expect(root.querySelector("canvas")).toBeNull();
    expect(root.querySelector("img")?.getAttribute("src")?.startsWith("data:image/")).toBe(true);
    return "data:image/png;base64,abc123";
  });
  const root = document.createElement("div");
  Object.defineProperty(root, "clientWidth", { value: 100 });
  Object.defineProperty(root, "clientHeight", { value: 50 });
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  Object.defineProperty(canvas, "offsetWidth", { value: 8 });
  Object.defineProperty(canvas, "offsetHeight", { value: 8 });
  root.appendChild(canvas);
  const { captureBrowserPage } = await import("./capture-page");
  await captureBrowserPage(root);
  expect(root.contains(canvas)).toBe(true);
});
