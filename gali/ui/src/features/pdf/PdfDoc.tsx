import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import { DocumentManagerPluginPackage } from "@embedpdf/plugin-document-manager/react";
import { RenderPluginPackage } from "@embedpdf/plugin-render/react";
import { ScrollPluginPackage } from "@embedpdf/plugin-scroll/react";
import { ViewportPluginPackage } from "@embedpdf/plugin-viewport/react";
import { AnnotationPluginPackage } from "@embedpdf/plugin-annotation/react";
import { InteractionManagerPluginPackage } from "@embedpdf/plugin-interaction-manager/react";
import { SearchPluginPackage } from "@embedpdf/plugin-search/react";
import { SelectionPluginPackage } from "@embedpdf/plugin-selection/react";
import { TilingPluginPackage } from "@embedpdf/plugin-tiling/react";
import { ZoomMode, ZoomPluginPackage } from "@embedpdf/plugin-zoom/react";
import { usePdfiumEngine } from "@embedpdf/engines/react";
import { getPlatform } from "../../platform/runtime";
import { PDF_DOCUMENT_ID } from "./pdf-engine";

/**
 * Every PDF surface in Gali mounts this: one registry per surface, all sharing
 * the process-wide pdfium worker.
 *
 * Takes bytes, not a URL. The document manager resolves a URL inside the pdfium
 * worker, and a blob: URL minted on the main thread never resolves there — the
 * load task simply never settles and the viewer hangs on "Loading…" with no
 * error. Every call site already has the bytes before it builds its object URL.
 */
export function PdfDoc({
  data,
  identity,
  name,
  scroll = true,
  interactive = false,
  children,
}: {
  data: ArrayBuffer;
  /** Distinguishes one file from the next, so a new file gets a new registry. */
  identity: string;
  name: string;
  /** Thumbnails render a single page and skip the viewport/scroll machinery. */
  scroll?: boolean;
  /** Full readers add selection, search, links, gestures, zoom, and tiled rendering. */
  interactive?: boolean;
  children: ReactNode;
}) {
  const plugins = useMemo(
    () => [
      createPluginRegistration(DocumentManagerPluginPackage, {
        initialDocuments: [{ buffer: data, name, documentId: PDF_DOCUMENT_ID }],
      }),
      createPluginRegistration(RenderPluginPackage),
      ...(scroll
        ? [
            createPluginRegistration(ViewportPluginPackage),
            createPluginRegistration(ScrollPluginPackage),
          ]
        : []),
      ...(interactive
        ? [
            createPluginRegistration(InteractionManagerPluginPackage),
            createPluginRegistration(SelectionPluginPackage),
            createPluginRegistration(SearchPluginPackage),
            createPluginRegistration(AnnotationPluginPackage, {
              autoCommit: false,
              autoOpenLinks: true,
            }),
            createPluginRegistration(ZoomPluginPackage, {
              defaultZoomLevel: ZoomMode.FitWidth,
              minZoom: 0.25,
              maxZoom: 8,
            }),
            createPluginRegistration(TilingPluginPackage, {
              tileSize: 768,
              overlapPx: 4,
              extraRings: 1,
            }),
          ]
        : []),
    ],
    [data, name, scroll, interactive],
  );

  const { engine, error } = usePdfiumEngine({ fontFallback: null });

  useEffect(() => {
    if (error) void getPlatform().reportError("pdf_engine_failed", error);
  }, [error]);

  if (error) return <div className="form-error">The PDF engine failed to start.</div>;
  if (!engine) return <p className="code-preview-loading">Loading PDF…</p>;

  // The registry binds its document at construction, so a new file is a new
  // registry rather than a reload.
  return (
    // autoMountDomElements off: it injects a hidden file picker input that Gali
    // never uses, once per PDF surface on the board.
    <EmbedPDF key={identity} engine={engine} plugins={plugins} autoMountDomElements={false}>
      {children}
    </EmbedPDF>
  );
}
