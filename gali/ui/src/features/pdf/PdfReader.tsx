import type { FormEvent, UIEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnnotationLayer } from "@embedpdf/plugin-annotation/react";
import { PagePointerProvider } from "@embedpdf/plugin-interaction-manager/react";
import { RenderLayer } from "@embedpdf/plugin-render/react";
import { SearchLayer, useSearch } from "@embedpdf/plugin-search/react";
import { Scroller, useScroll, useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { CopyToClipboard, SelectionLayer, useSelectionCapability } from "@embedpdf/plugin-selection/react";
import { TilingLayer } from "@embedpdf/plugin-tiling/react";
import { Viewport } from "@embedpdf/plugin-viewport/react";
import {
  MarqueeZoom,
  ZoomGestureWrapper,
  ZoomMode,
  useZoom,
} from "@embedpdf/plugin-zoom/react";
import type { PdfAnnotationDto } from "../../api";
import { PdfAnnotationOverlay, PdfFlashOverlay, type PdfFlash } from "./PdfAnnotationOverlay";
import { PDF_DOCUMENT_ID } from "./pdf-engine";

const SCROLL_QUANTIZE = 16;
const SCROLL_SETTLE_MS = 280;

function scrollKeyOf(element: HTMLElement): string {
  const quantize = (value: number) =>
    String(Math.round(value / SCROLL_QUANTIZE) * SCROLL_QUANTIZE);
  return `${quantize(element.scrollTop)}:${quantize(element.scrollLeft)}`;
}

function PdfToolbar({
  onViewChanging,
}: {
  onViewChanging: () => void;
}) {
  const { state: scrollState, provides: scroll } = useScroll(PDF_DOCUMENT_ID);
  const { state: zoomState, provides: zoom } = useZoom(PDF_DOCUMENT_ID);
  const { state: searchState, provides: search } = useSearch(PDF_DOCUMENT_ID);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery("");
    search?.stopSearch();
  }, [search]);

  const changeZoom = useCallback((change: () => void) => {
    onViewChanging();
    change();
  }, [onViewChanging]);

  const submitSearch = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = query.trim();
    if (!search) return;
    if (!normalized) {
      search.stopSearch();
      return;
    }
    search.startSearch();
    void search.searchAllPages(normalized).toPromise();
  }, [query, search]);

  useEffect(() => {
    if (!scroll || searchState.activeResultIndex < 0) return;
    const result = searchState.results[searchState.activeResultIndex];
    if (result) scroll.scrollToPage({ pageNumber: result.pageIndex + 1 });
  }, [scroll, searchState.activeResultIndex, searchState.results]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".pdf-toolbar-search-input")?.focus();
        return;
      }
      if (typing || !zoom || !scroll) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeZoom(() => zoom.zoomIn());
      } else if (event.key === "-") {
        event.preventDefault();
        changeZoom(() => zoom.zoomOut());
      } else if (event.key === "0") {
        event.preventDefault();
        changeZoom(() => zoom.requestZoom(ZoomMode.FitWidth));
      } else if (event.key === "PageDown") {
        event.preventDefault();
        scroll.scrollToNextPage();
      } else if (event.key === "PageUp") {
        event.preventDefault();
        scroll.scrollToPreviousPage();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeZoom, scroll, zoom]);

  const page = Math.max(1, scrollState.currentPage);
  const pages = Math.max(1, scrollState.totalPages);
  const resultNumber = searchState.total > 0 ? searchState.activeResultIndex + 1 : 0;

  return (
    <div
      className={`pdf-toolbar${searchOpen ? " is-search-open" : ""}`}
      role="toolbar"
      aria-label="PDF controls"
    >
      <div className="pdf-toolbar-group pdf-toolbar-navigation">
        <button
          type="button"
          disabled={!scroll || page <= 1}
          onClick={() => scroll?.scrollToPreviousPage()}
          aria-label="Previous page"
        >
          ‹
        </button>
        <span className="pdf-toolbar-page">{`${page} / ${pages}`}</span>
        <button
          type="button"
          disabled={!scroll || page >= pages}
          onClick={() => scroll?.scrollToNextPage()}
          aria-label="Next page"
        >
          ›
        </button>
      </div>

      <div className="pdf-toolbar-group pdf-toolbar-zoom-controls">
        <button
          type="button"
          disabled={!zoom}
          onClick={() => zoom && changeZoom(() => zoom.zoomOut())}
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="pdf-toolbar-zoom">
          {`${Math.round(zoomState.currentZoomLevel * 100)}%`}
        </span>
        <button
          type="button"
          disabled={!zoom}
          onClick={() => zoom && changeZoom(() => zoom.zoomIn())}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="pdf-toolbar-fit"
          disabled={!zoom}
          onClick={() => zoom && changeZoom(() => zoom.requestZoom(ZoomMode.FitWidth))}
          aria-label="Fit PDF to width"
        >
          Fit width
        </button>
        <button
          type="button"
          className="pdf-toolbar-fit"
          disabled={!zoom}
          onClick={() => zoom && changeZoom(() => zoom.requestZoom(ZoomMode.FitPage))}
          aria-label="Fit PDF page"
        >
          Fit page
        </button>
      </div>

      <button
        type="button"
        className="pdf-toolbar-searchtoggle"
        onClick={() => setSearchOpen(true)}
        aria-label="Find in PDF"
      >
        ⌕
      </button>

      <form className="pdf-toolbar-search" onSubmit={submitSearch}>
        <input
          className="pdf-toolbar-search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find in PDF"
          aria-label="Find in PDF"
        />
        <button
          type="submit"
          className="pdf-toolbar-find"
          disabled={!search || query.trim().length === 0}
          aria-label="Search PDF"
        >
          <span className="pdf-toolbar-find-wide">Find</span>
          <span className="pdf-toolbar-find-compact" aria-hidden="true">⌕</span>
        </button>
        <button
          type="button"
          disabled={!search || searchState.total === 0}
          onClick={() => search?.previousResult()}
          aria-label="Previous search result"
        >
          ↑
        </button>
        <button
          type="button"
          disabled={!search || searchState.total === 0}
          onClick={() => search?.nextResult()}
          aria-label="Next search result"
        >
          ↓
        </button>
        <span className="pdf-toolbar-results" aria-live="polite">
          {searchState.loading
            ? "Searching…"
            : query.trim() && searchState.active
              ? `${resultNumber}/${searchState.total}`
              : ""}
        </span>
        <button
          type="button"
          className="pdf-toolbar-searchclose"
          onClick={closeSearch}
          aria-label="Close search"
        >
          ✕
        </button>
      </form>
    </div>
  );
}

export type PdfSelectionAction = "highlight" | "note";

function SelectionMenu({ onAction }: { onAction: (action: PdfSelectionAction, quote: string, page: number) => void }) {
  const { provides: selection } = useSelectionCapability();
  const [busy, setBusy] = useState(false);

  async function run(action: PdfSelectionAction) {
    if (!selection || busy) return;
    const first = selection.getFormattedSelection(PDF_DOCUMENT_ID)[0];
    if (!first) return;
    setBusy(true);
    try {
      const texts = await selection.getSelectedText(PDF_DOCUMENT_ID).toPromise();
      const quote = (texts[0] ?? "").replace(/\s+/g, " ").trim();
      if (quote) onAction(action, quote, first.pageIndex + 1);
      selection.clear(PDF_DOCUMENT_ID);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pdf-selection-menu" role="toolbar" aria-label="Selection">
      <button type="button" disabled={busy} onPointerDown={(event) => event.stopPropagation()} onClick={() => void run("highlight")}>
        <span className="pdf-selection-swatch" aria-hidden="true" />
        Highlight
      </button>
      <button type="button" disabled={busy} onPointerDown={(event) => event.stopPropagation()} onClick={() => void run("note")}>
        Note
      </button>
    </div>
  );
}

function PdfPage({
  pageIndex,
  pageNumber,
  annotations,
  flash,
  onPageRendered,
  onSelectionAction,
}: {
  pageIndex: number;
  pageNumber: number;
  annotations: readonly PdfAnnotationDto[];
  flash: PdfFlash | null;
  onPageRendered?: () => void;
  onSelectionAction?: (action: PdfSelectionAction, quote: string, page: number) => void;
}) {
  return (
    <PagePointerProvider
      documentId={PDF_DOCUMENT_ID}
      pageIndex={pageIndex}
      className="tile-viewer-pdf-page"
      data-page={pageNumber}
    >
      <RenderLayer
        documentId={PDF_DOCUMENT_ID}
        pageIndex={pageIndex}
        scale={1}
        className="source-file-pdf-page-sheet pdf-page-base-layer"
        onLoad={onPageRendered}
      />
      <TilingLayer
        documentId={PDF_DOCUMENT_ID}
        pageIndex={pageIndex}
        className="pdf-page-overlay"
      />
      <SearchLayer
        documentId={PDF_DOCUMENT_ID}
        pageIndex={pageIndex}
        className="pdf-page-overlay"
        highlightColor="rgba(255, 210, 64, 0.42)"
        activeHighlightColor="rgba(252, 76, 2, 0.58)"
      />
      <SelectionLayer
        documentId={PDF_DOCUMENT_ID}
        pageIndex={pageIndex}
        textStyle={{ background: "rgba(66, 133, 244, 0.32)" }}
        selectionMenu={onSelectionAction
          ? ({ menuWrapperProps, placement }) => (
            <div {...menuWrapperProps}>
              <div className={`pdf-selection-anchor${placement.suggestTop ? " is-above" : ""}`}>
                <SelectionMenu onAction={onSelectionAction} />
              </div>
            </div>
          )
          : undefined}
      />
      <AnnotationLayer
        documentId={PDF_DOCUMENT_ID}
        pageIndex={pageIndex}
        className="pdf-page-overlay"
      />
      <PdfAnnotationOverlay pageNumber={pageNumber} annotations={annotations} />
      <PdfFlashOverlay pageNumber={pageNumber} flash={flash} />
      <MarqueeZoom
        documentId={PDF_DOCUMENT_ID}
        pageIndex={pageIndex}
        className="pdf-page-overlay"
      />
    </PagePointerProvider>
  );
}

export function PdfReader({
  page,
  annotations,
  flash = null,
  onPageChange,
  onViewChanging,
  onViewSettled,
  onScrollKey,
  onSelectionAction,
}: {
  page: number;
  annotations: readonly PdfAnnotationDto[];
  flash?: PdfFlash | null;
  onPageChange: (page: number) => void;
  onViewChanging: (duringJump?: boolean) => void;
  onViewSettled: () => void;
  onScrollKey: (key: string) => void;
  onSelectionAction?: (action: PdfSelectionAction, quote: string, page: number) => void;
}) {
  const { state, provides } = useScroll(PDF_DOCUMENT_ID);
  const { provides: scrollCapability } = useScrollCapability();
  const { state: zoomState } = useZoom(PDF_DOCUMENT_ID);
  const { currentPage } = state;
  const [layoutPages, setLayoutPages] = useState<number | null>(null);
  const requestedPage = layoutPages === null
    ? Math.max(1, page)
    : Math.min(Math.max(1, page), layoutPages);
  const pageRef = useRef(page);
  pageRef.current = page;
  const reportedPage = useRef<number | null>(null);
  const appliedPage = useRef<number | null>(null);
  const scrollTimer = useRef(0);
  const jumpTimer = useRef(0);
  const previousZoom = useRef(zoomState.currentZoomLevel);
  const previousPage = useRef(currentPage);
  // currentPage becomes the target at the start of a smooth jump. The screenshot
  // waits until EmbedPDF clears pageChangeState.isChanging.
  const [jumping, setJumping] = useState(false);
  const waitingForJump = useRef(false);

  useEffect(() => {
    if (!scrollCapability || !provides) return;
    const onReady = scrollCapability.onLayoutReady;
    if (!onReady) return;
    // Ready fires after the Scroller has content and restored its own offset; a jump before that is undone.
    return onReady((event) => {
      if (event.documentId !== PDF_DOCUMENT_ID || event.totalPages < 1) return;
      setLayoutPages(event.totalPages);
    });
  }, [scrollCapability, provides]);

  useEffect(() => {
    if (!provides || layoutPages === null) return;
    const target = Math.min(Math.max(1, page), layoutPages);
    if (reportedPage.current === target) {
      appliedPage.current = target;
      return;
    }
    if (appliedPage.current === target) return;
    const firstPosition = appliedPage.current === null;
    appliedPage.current = target;
    if (provides.getCurrentPage() === target) return;
    provides.scrollToPage({
      pageNumber: target,
      behavior: firstPosition ? "instant" : "smooth",
    });
  }, [provides, layoutPages, page]);

  const reportPage = useCallback((nextPage: number) => {
    if (layoutPages === null) return;
    const next = Math.min(Math.max(1, nextPage), layoutPages);
    if (next === pageRef.current) return;
    reportedPage.current = next;
    appliedPage.current = next;
    onPageChange(next);
  }, [layoutPages, onPageChange]);

  useEffect(() => {
    if (!provides || layoutPages === null) return;
    return provides.onPageChange((event) => {
      if (provides.getPageChangeState().isChanging) return;
      reportPage(event.pageNumber);
    });
  }, [provides, layoutPages, reportPage]);

  const finishJump = useCallback(() => {
    waitingForJump.current = false;
    onViewSettled();
  }, [onViewSettled]);

  const armJumpEnd = useCallback(() => {
    window.clearTimeout(jumpTimer.current);
    jumpTimer.current = window.setTimeout(finishJump, SCROLL_SETTLE_MS);
  }, [finishJump]);

  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(
      () => onScrollKey(scrollKeyOf(element)),
      SCROLL_SETTLE_MS,
    );
    if (waitingForJump.current) armJumpEnd();
  }, [armJumpEnd, onScrollKey]);

  useEffect(() => () => {
    window.clearTimeout(scrollTimer.current);
    window.clearTimeout(jumpTimer.current);
  }, []);

  useEffect(() => {
    if (!scrollCapability) return;
    return scrollCapability.onPageChangeState((event) => {
      if (event.documentId !== PDF_DOCUMENT_ID) return;
      setJumping(event.state.isChanging);
      if (event.state.isChanging || !provides || layoutPages === null) return;
      reportPage(provides.getCurrentPage());
    });
  }, [scrollCapability, provides, layoutPages, reportPage]);

  useEffect(() => {
    if (previousZoom.current === zoomState.currentZoomLevel) return;
    previousZoom.current = zoomState.currentZoomLevel;
    onViewChanging();
  }, [zoomState.currentZoomLevel, onViewChanging]);

  useEffect(() => {
    if (currentPage <= 0 || previousPage.current === currentPage) return;
    previousPage.current = currentPage;
    if (jumping || waitingForJump.current) return;
    onViewChanging();
  }, [currentPage, jumping, onViewChanging]);

  useEffect(() => {
    window.clearTimeout(jumpTimer.current);
    if (jumping) {
      waitingForJump.current = true;
      onViewChanging(true);
      return;
    }
    if (!waitingForJump.current || currentPage <= 0 || currentPage !== requestedPage) return;
    armJumpEnd();
  }, [armJumpEnd, currentPage, jumping, onViewChanging, requestedPage]);

  return (
    <>
      <PdfToolbar onViewChanging={onViewChanging} />
      <ZoomGestureWrapper
        documentId={PDF_DOCUMENT_ID}
        className="tile-viewer-pdf-gesture"
        enablePinch
        enableWheel
      >
        <Viewport
          documentId={PDF_DOCUMENT_ID}
          className="tile-viewer-pdf-viewport"
          onScroll={onScroll}
        >
          <Scroller
            documentId={PDF_DOCUMENT_ID}
            renderPage={(layout) => (
              <PdfPage
                pageIndex={layout.pageIndex}
                pageNumber={layout.pageNumber}
                annotations={annotations}
                flash={flash}
                onPageRendered={
                  !jumping && layout.pageNumber === requestedPage ? onViewSettled : undefined
                }
                onSelectionAction={onSelectionAction}
              />
            )}
          />
        </Viewport>
      </ZoomGestureWrapper>
      <CopyToClipboard />
    </>
  );
}
