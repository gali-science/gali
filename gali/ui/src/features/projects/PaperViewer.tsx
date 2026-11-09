import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentContent } from "@embedpdf/plugin-document-manager/react";
import { readProjectMedia, type PdfAnnotationDto } from "../../api";
import type { PdfFlash } from "../pdf/PdfAnnotationOverlay";
import { PdfDoc } from "../pdf/PdfDoc";
import { PdfReader, type PdfSelectionAction } from "../pdf/PdfReader";
import { PDF_DOCUMENT_ID } from "../pdf/pdf-engine";
import { fileName } from "./file-kind";

export function PaperViewer({
  projectKey,
  path,
  page,
  annotations,
  flash = null,
  onPageChange,
  onSelectionAction,
  onSettledView,
  onDismissedView,
}: {
  projectKey: string;
  path: string;
  page: number;
  annotations: readonly PdfAnnotationDto[];
  flash?: PdfFlash | null;
  onPageChange: (page: number) => void;
  onSelectionAction?: (action: PdfSelectionAction, quote: string, page: number) => void;
  onSettledView?: (target: { path: string; page: number }) => void;
  onDismissedView?: () => void;
}) {
  const [pdfData, setPdfData] = useState<ArrayBuffer | null>(null);
  const [error, setError] = useState("");
  // data-tile-ready is polled by view-capture.ts before snapshotting for the model
  const [viewState, setViewState] = useState<"loading" | "ready">("loading");
  const [scrollKey, setScrollKey] = useState("0:0");
  const renderTimer = useRef(0);

  // Readiness must reset in the same commit as a page change: the capture
  // poller reads the DOM between commit and effects, and a stale "ready"
  // paired with the new page gets snapshotted as the previous one.
  const viewIdentity = `${path}:${page}`;
  const [lastIdentity, setLastIdentity] = useState(viewIdentity);
  if (lastIdentity !== viewIdentity) {
    setLastIdentity(viewIdentity);
    setViewState("loading");
  }

  useEffect(() => {
    if (error || viewState !== "ready") return;
    onSettledView?.({ path, page });
  }, [error, viewState, path, page, scrollKey, onSettledView]);

  useEffect(() => () => onDismissedView?.(), [onDismissedView]);

  const onViewChanging = useCallback((duringJump = false) => {
    window.clearTimeout(renderTimer.current);
    setViewState("loading");
    if (duringJump) return;
    renderTimer.current = window.setTimeout(() => setViewState("ready"), 900);
  }, []);
  const onViewSettled = useCallback(() => {
    window.clearTimeout(renderTimer.current);
    setViewState("ready");
  }, []);

  useEffect(() => () => window.clearTimeout(renderTimer.current), []);

  useEffect(() => {
    let cancelled = false;
    setPdfData(null);
    setError("");
    void readProjectMedia(projectKey, path)
      .then((document) => {
        if (cancelled) return;
        const bytes = new Uint8Array(document.data.byteLength);
        bytes.set(document.data);
        setPdfData(bytes.buffer);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, path]);

  return (
    <section
      className="tile-viewer paper-viewer"
      aria-label="PDF"
      data-tile-capture="true"
      data-tile-kind="paper"
      data-tile-path={path}
      data-tile-page={String(page)}
      data-tile-scroll={scrollKey}
      data-tile-ready={error ? "ready" : viewState}
    >
      <div className="tile-viewer-body">
        {error ? <div className="form-error">{error}</div> : null}
        {pdfData ? (
          <div className="tile-viewer-pdf">
            <PdfDoc data={pdfData} identity={path} name={fileName(path)} interactive>
              <DocumentContent documentId={PDF_DOCUMENT_ID}>
                {({ isError, isLoaded }) =>
                  isError
                    ? <div className="form-error">This PDF could not be opened.</div>
                    : isLoaded
                      ? (
                        <PdfReader
                          page={page}
                          annotations={annotations}
                          flash={flash}
                          onPageChange={onPageChange}
                          onViewChanging={onViewChanging}
                          onViewSettled={onViewSettled}
                          onScrollKey={setScrollKey}
                          onSelectionAction={onSelectionAction}
                        />
                      )
                      : <p className="code-preview-loading">Loading PDF…</p>}
              </DocumentContent>
            </PdfDoc>
          </div>
        ) : !error && <p className="code-preview-loading">Loading…</p>}
      </div>
    </section>
  );
}
