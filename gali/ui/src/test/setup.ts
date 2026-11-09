import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom has no pdfium worker and no wasm. Every suite gets an inert PDF stack;
// suites that assert on page rendering override these with their own mocks.
vi.mock("@embedpdf/engines/react", () => ({
  usePdfiumEngine: () => ({ engine: {}, isLoading: false, error: null }),
}));
vi.mock("@embedpdf/core", () => ({
  createPluginRegistration: () => ({}),
}));
vi.mock("@embedpdf/core/react", () => ({
  EmbedPDF: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("@embedpdf/plugin-document-manager/react", () => ({
  DocumentManagerPluginPackage: {},
  DocumentContent: ({
    children,
  }: {
    children: (props: {
      documentState: null;
      isLoading: boolean;
      isError: boolean;
      isLoaded: boolean;
    }) => unknown;
  }) => children({ documentState: null, isLoading: false, isError: false, isLoaded: true }),
}));
vi.mock("@embedpdf/plugin-render/react", () => ({
  RenderPluginPackage: {},
  RenderLayer: () => null,
}));
vi.mock("@embedpdf/plugin-scroll/react", () => ({
  ScrollPluginPackage: {},
  Scroller: () => null,
  useScroll: () => ({ state: { currentPage: 0, totalPages: 0 }, provides: null }),
  useScrollCapability: () => ({ provides: null, isLoading: false, ready: Promise.resolve() }),
}));
vi.mock("@embedpdf/plugin-viewport/react", () => ({
  ViewportPluginPackage: {},
  Viewport: ({ children }: { children?: unknown }) => children ?? null,
}));

afterEach(() => cleanup());
