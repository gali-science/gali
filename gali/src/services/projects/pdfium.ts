import fs from "node:fs";
import { createRequire } from "node:module";
import type { WrappedPdfiumModule } from "@embedpdf/pdfium";
import type { PdfRect } from "../../../shared/domain/contracts.js";

const RENDER_ANNOTATIONS = 0x01;
const ANNOT_LINK = 2;
const ANNOT_TEXT = 1;
const ANNOT_HIGHLIGHT = 9;
const COLOR_STROKE = 0;
const ICON_NOTE = 2;
const BLEND_MULTIPLY = 1;
const FLAG_PRINT = 4;
const FLAG_NO_ZOOM = 8;
const FLAG_NO_ROTATE = 16;

type Rgb = readonly [number, number, number];

export type PdfiumAnnotation = { kind: "highlight" | "note" | "link" | "other"; contents: string };

/** One page, open for the duration of `PdfiumDocument.page`. Rects are top-left origin, in points. */
export type PdfiumPage = {
  readonly number: number;
  readonly width: number;
  readonly height: number;
  /** Raw page text; index i is PDFium's character i, as `textRects` expects. */
  text(): string;
  textRects(start: number, count: number): PdfRect[];
  render(dpi: number): { width: number; height: number; rgb: Buffer };
  addHighlight(input: { rects: readonly PdfRect[]; rgb: Rgb; author: string; contents: string }): void;
  addNote(input: { rect: PdfRect; rgb: Rgb; author: string; contents: string }): void;
  annotations(): PdfiumAnnotation[];
};

export type PdfiumDocument = {
  readonly pageCount: number;
  /** `use` must be synchronous: the page closes when it returns. */
  page<T>(number: number, use: (page: PdfiumPage) => T): T;
  save(): Uint8Array;
};

type Runtime = {
  HEAPU8: Uint8Array;
  UTF16ToString(pointer: number): string;
};

let pdfium: Promise<WrappedPdfiumModule> | null = null;

function loadPdfium(): Promise<WrappedPdfiumModule> {
  pdfium ??= (async () => {
    // Loaded lazily: manual source deploys skip pnpm install, and a missing
    // package must only disable PDF features, not stop the server from booting.
    const { init } = await import("@embedpdf/pdfium");
    const require = createRequire(import.meta.url);
    const bytes = fs.readFileSync(require.resolve("@embedpdf/pdfium/pdfium.wasm"));
    const lib = await init({
      wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    });
    lib.FPDF_InitLibrary();
    return lib;
  })();
  return pdfium;
}

function must(ok: unknown, what: string): void {
  if (!ok) throw new Error(`pdfium could not ${what}`);
}

class Memory {
  constructor(private readonly lib: WrappedPdfiumModule) {}

  private get runtime(): Runtime {
    return this.lib.pdfium as unknown as Runtime;
  }

  // HEAPU8 is re-read on every access: wasm memory growth replaces the buffer.
  private get view(): DataView {
    return new DataView(this.runtime.HEAPU8.buffer);
  }

  alloc(bytes: number): number {
    const pointer = this.lib.pdfium.wasmExports.malloc(bytes);
    must(pointer, `allocate ${bytes} bytes`);
    return pointer;
  }

  free(pointer: number): void {
    this.lib.pdfium.wasmExports.free(pointer);
  }

  /** Synchronous `use` only: the memory is freed when it returns. */
  with<T>(bytes: number, use: (pointer: number) => T): T {
    const pointer = this.alloc(bytes);
    try {
      return use(pointer);
    } finally {
      this.free(pointer);
    }
  }

  copyIn(pointer: number, bytes: Uint8Array): void {
    this.runtime.HEAPU8.set(bytes, pointer);
  }

  copyOut(pointer: number, length: number): Uint8Array {
    return this.runtime.HEAPU8.slice(pointer, pointer + length);
  }

  floats(pointer: number, values: readonly number[]): void {
    const view = this.view;
    values.forEach((value, i) => view.setFloat32(pointer + i * 4, value, true));
  }

  doubles(pointer: number, count: number): number[] {
    const view = this.view;
    return Array.from({ length: count }, (_, i) => view.getFloat64(pointer + i * 8, true));
  }

  utf16(pointer: number): string {
    return this.runtime.UTF16ToString(pointer);
  }

  withUtf16<T>(value: string, use: (pointer: number) => T): T {
    return this.with((value.length + 1) * 2, (pointer) => {
      const view = this.view;
      for (let i = 0; i < value.length; i += 1) view.setUint16(pointer + i * 2, value.charCodeAt(i), true);
      view.setUint16(pointer + value.length * 2, 0, true);
      return use(pointer);
    });
  }
}

function openPage(lib: WrappedPdfiumModule, memory: Memory, handle: number, number: number): PdfiumPage & { close(): void } {
  const width = lib.FPDF_GetPageWidthF(handle);
  const height = lib.FPDF_GetPageHeightF(handle);
  let textPage = 0;
  const loadText = () => {
    textPage ||= lib.FPDFText_LoadPage(handle);
    must(textPage, `read the text of page ${number}`);
    return textPage;
  };
  const toPdf = (rect: PdfRect) => ({
    left: rect.x,
    right: rect.x + rect.width,
    top: height - rect.y,
    bottom: height - rect.y - rect.height,
  });

  function annotate(subtype: number, write: (annot: number, scratch: number) => void) {
    const annot = lib.FPDFPage_CreateAnnot(handle, subtype);
    must(annot, `add an annotation to page ${number}`);
    try {
      memory.with(32, (scratch) => write(annot, scratch));
    } finally {
      lib.FPDFPage_CloseAnnot(annot);
    }
  }

  function finish(annot: number, rgb: Rgb, flags: number, author: string, contents: string) {
    must(lib.EPDFAnnot_SetColor(annot, COLOR_STROKE, rgb[0], rgb[1], rgb[2]), "color an annotation");
    must(lib.FPDFAnnot_SetFlags(annot, flags), "flag an annotation");
    for (const [key, value] of [["T", author], ["Contents", contents]] as const) {
      must(memory.withUtf16(value, (pointer) => lib.FPDFAnnot_SetStringValue(annot, key, pointer)), `set annotation ${key}`);
    }
  }

  function bounds(scratch: number, annot: number, rect: { left: number; top: number; right: number; bottom: number }) {
    memory.floats(scratch, [rect.left, rect.top, rect.right, rect.bottom]);
    must(lib.FPDFAnnot_SetRect(annot, scratch), "size an annotation");
  }

  return {
    number,
    width,
    height,

    text() {
      const page = loadText();
      const count = lib.FPDFText_CountChars(page);
      return memory.with((count + 1) * 2, (buffer) => {
        lib.FPDFText_GetText(page, 0, count, buffer);
        return memory.utf16(buffer);
      });
    },

    textRects(start, count) {
      const page = loadText();
      const total = lib.FPDFText_CountRects(page, start, count);
      return memory.with(32, (out) => {
        const rects: PdfRect[] = [];
        for (let i = 0; i < total; i += 1) {
          must(lib.FPDFText_GetRect(page, i, out, out + 8, out + 16, out + 24), `read text box ${i} on page ${number}`);
          const [left, top, right, bottom] = memory.doubles(out, 4) as [number, number, number, number];
          if (right <= left || top <= bottom) continue;
          rects.push({ x: left, y: height - top, width: right - left, height: top - bottom });
        }
        return rects;
      });
    },

    render(dpi) {
      const pixelWidth = Math.round((width * dpi) / 72);
      const pixelHeight = Math.round((height * dpi) / 72);
      const bitmap = lib.FPDFBitmap_Create(pixelWidth, pixelHeight, 0);
      must(bitmap, `allocate a bitmap for page ${number}`);
      try {
        lib.FPDFBitmap_FillRect(bitmap, 0, 0, pixelWidth, pixelHeight, 0xffffffff);
        lib.FPDF_RenderPageBitmap(bitmap, handle, 0, 0, pixelWidth, pixelHeight, 0, RENDER_ANNOTATIONS);
        const stride = lib.FPDFBitmap_GetStride(bitmap);
        const bgrx = memory.copyOut(lib.FPDFBitmap_GetBuffer(bitmap), stride * pixelHeight);
        const rgb = Buffer.alloc(pixelWidth * pixelHeight * 3);
        for (let y = 0; y < pixelHeight; y += 1) {
          for (let x = 0; x < pixelWidth; x += 1) {
            const source = y * stride + x * 4;
            const target = (y * pixelWidth + x) * 3;
            rgb[target] = bgrx[source + 2]!;
            rgb[target + 1] = bgrx[source + 1]!;
            rgb[target + 2] = bgrx[source]!;
          }
        }
        return { width: pixelWidth, height: pixelHeight, rgb };
      } finally {
        lib.FPDFBitmap_Destroy(bitmap);
      }
    },

    addHighlight({ rects, rgb, author, contents }) {
      if (rects.length === 0) throw new Error("a highlight needs at least one rect");
      annotate(ANNOT_HIGHLIGHT, (annot, scratch) => {
        const boxes = rects.map(toPdf);
        for (const box of boxes) {
          memory.floats(scratch, [box.left, box.top, box.right, box.top, box.left, box.bottom, box.right, box.bottom]);
          must(lib.FPDFAnnot_AppendAttachmentPoints(annot, scratch), "place a highlight");
        }
        bounds(scratch, annot, {
          left: Math.min(...boxes.map((box) => box.left)),
          top: Math.max(...boxes.map((box) => box.top)),
          right: Math.max(...boxes.map((box) => box.right)),
          bottom: Math.min(...boxes.map((box) => box.bottom)),
        });
        finish(annot, rgb, FLAG_PRINT, author, contents);
        must(lib.EPDFAnnot_GenerateAppearanceWithBlend(annot, BLEND_MULTIPLY), "draw a highlight");
      });
    },

    addNote({ rect, rgb, author, contents }) {
      annotate(ANNOT_TEXT, (annot, scratch) => {
        bounds(scratch, annot, toPdf(rect));
        must(lib.EPDFAnnot_SetName(annot, ICON_NOTE), "set the note icon");
        finish(annot, rgb, FLAG_PRINT | FLAG_NO_ZOOM | FLAG_NO_ROTATE, author, contents);
        must(lib.EPDFAnnot_GenerateAppearance(annot), "draw a note");
      });
    },

    annotations() {
      const found: PdfiumAnnotation[] = [];
      const count = lib.FPDFPage_GetAnnotCount(handle);
      for (let i = 0; i < count; i += 1) {
        const annot = lib.FPDFPage_GetAnnot(handle, i);
        must(annot, `read annotation ${i} on page ${number}`);
        try {
          const subtype = lib.FPDFAnnot_GetSubtype(annot);
          const length = lib.FPDFAnnot_GetStringValue(annot, "Contents", 0, 0);
          const contents = memory.with(length, (buffer) => {
            lib.FPDFAnnot_GetStringValue(annot, "Contents", buffer, length);
            return memory.utf16(buffer);
          });
          const kind = subtype === ANNOT_HIGHLIGHT
            ? "highlight"
            : subtype === ANNOT_TEXT
              ? "note"
              : subtype === ANNOT_LINK
                ? "link"
                : "other";
          found.push({ kind, contents });
        } finally {
          lib.FPDFPage_CloseAnnot(annot);
        }
      }
      return found;
    },

    close() {
      if (textPage) lib.FPDFText_ClosePage(textPage);
      lib.FPDF_ClosePage(handle);
    },
  };
}

/** Opens a PDF held in memory for the duration of `use`, which may be async. */
export async function withPdfDocument<T>(
  bytes: Uint8Array,
  use: (doc: PdfiumDocument) => T | Promise<T>,
): Promise<T> {
  const lib = await loadPdfium();
  const memory = new Memory(lib);
  // PDFium reads the file buffer lazily, so it must outlive every await in `use`.
  const file = memory.alloc(bytes.length);
  try {
    memory.copyIn(file, bytes);
    const handle = lib.FPDF_LoadMemDocument(file, bytes.length, "");
    must(handle, "open the PDF");
    try {
      const pageCount = lib.FPDF_GetPageCount(handle);
      return await use({
        pageCount,
        page(number, usePage) {
          if (!Number.isInteger(number) || number < 1 || number > pageCount) {
            throw new Error(`page ${number} is out of range (1–${pageCount})`);
          }
          const pageHandle = lib.FPDF_LoadPage(handle, number - 1);
          must(pageHandle, `open page ${number}`);
          const page = openPage(lib, memory, pageHandle, number);
          try {
            return usePage(page);
          } finally {
            page.close();
          }
        },
        save() {
          const writer = lib.PDFiumExt_OpenFileWriter();
          must(writer, "start writing the PDF");
          try {
            must(lib.PDFiumExt_SaveAsCopy(handle, writer), "save the PDF");
            const size = lib.PDFiumExt_GetFileWriterSize(writer);
            return memory.with(size, (data) => {
              lib.PDFiumExt_GetFileWriterData(writer, data, size);
              return memory.copyOut(data, size);
            });
          } finally {
            lib.PDFiumExt_CloseFileWriter(writer);
          }
        },
      });
    } finally {
      lib.FPDF_CloseDocument(handle);
    }
  } finally {
    memory.free(file);
  }
}
