import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProjectTab, ReviewFinding, ReviewPaperAnchor } from "../../../../shared/domain/contracts";
import {
  createPdfAnnotation,
  deletePdfAnnotation,
  dismissFinding,
  getProject,
  getReview,
  onNavEvent,
  onProjectEvent,
  readPdfAnnotations,
  restoreFinding,
  setPdfAnnotationNote,
  type PdfAnnotationDto,
  type ProjectDto,
  type ReviewDto,
} from "../../api";
import { usePhoneShell } from "../../hooks/use-phone-shell";
import type { WorkspaceNavigationCommand } from "../../navigation";
import type { PdfFlash } from "../pdf/PdfAnnotationOverlay";
import type { PdfSelectionAction } from "../pdf/PdfReader";
import { AgentRow, useAgentRun } from "./AgentRow";
import { CodeWorkspace } from "./CodeWorkspace";
import { DeleteProjectDialog } from "./DeleteProjectDialog";
import { fileName } from "./file-kind";
import { NotesPanel } from "./NotesPanel";
import { PaperViewer } from "./PaperViewer";
import { findingNote, ReviewPanel } from "./ReviewPanel";

type PhoneView = "paper" | ProjectTab;

const FLASH_MS = 3500;
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.75;
const SPLITTER_PX = 9;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function SideTab({
  label,
  on,
  icon,
  meta,
  onSelect,
  onClose,
}: {
  label: string;
  on: boolean;
  icon: ReactNode;
  meta?: ReactNode;
  onSelect: () => void;
  onClose?: () => void;
}) {
  return (
    <div className={`side-tab${on ? " is-on" : ""}`}>
      <button type="button" role="tab" aria-selected={on} className="side-tab-main" onClick={onSelect}>
        {icon}
        <span className="side-tab-label">{label}</span>
        {meta ? <span className="side-tab-meta">{meta}</span> : null}
      </button>
      {onClose ? (
        <button type="button" className="side-tab-close" onClick={onClose} aria-label={`Close ${label}`} title="Close">
          ×
        </button>
      ) : null}
    </div>
  );
}

export function ProjectWorkspace({
  projectKey,
  refreshKey,
  navigationCommand,
  reviewerBusy,
  onGoHome,
  onOpenAccount,
  onDeleted,
  onViewChange,
  onTileSettled,
  onTileDismissed,
  chat,
  bar,
}: {
  projectKey: string;
  refreshKey: number;
  navigationCommand: WorkspaceNavigationCommand | null;
  reviewerBusy: boolean;
  onGoHome: () => void;
  onOpenAccount: () => void;
  onDeleted: () => void;
  onViewChange?: (view: string) => void;
  onTileSettled?: (target: { path: string; page: number }) => void;
  onTileDismissed?: () => void;
  /** The Chat tab's content on desktop. */
  chat: ReactNode;
  bar: ReactNode;
}) {
  const phone = usePhoneShell();
  const [loaded, setLoaded] = useState<ProjectDto | null>(null);
  const project = loaded?.key === projectKey ? loaded : null;
  const [tab, setTab] = useState<ProjectTab | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [phoneView, setPhoneView] = useState<PhoneView>("paper");
  const [split, setSplit] = useState(0.58);
  const [wide, setWide] = useState(false);
  const [page, setPage] = useState(1);
  const [codePath, setCodePath] = useState<string | null>(null);
  const [codeLines, setCodeLines] = useState<[number, number] | null>(null);
  const [flash, setFlash] = useState<PdfFlash | null>(null);
  const [review, setReview] = useState<ReviewDto | null | undefined>(undefined);
  const [reviewError, setReviewError] = useState("");
  const [reviewSeenAt, setReviewSeenAt] = useState<string | null | undefined>(undefined);
  const [annotations, setAnnotations] = useState<PdfAnnotationDto[]>([]);
  const [annotationsError, setAnnotationsError] = useState("");
  const [focusNote, setFocusNote] = useState<number | null>(null);
  const [focusFinding, setFocusFinding] = useState<{ id: string; nonce: number } | null>(null);
  const [filesRevision, setFilesRevision] = useState(0);
  const [annotationsRevision, setAnnotationsRevision] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState("");
  const consumedNavigationCommandId = useRef(0);
  const actionsMenuRef = useRef<HTMLDivElement | null>(null);
  const phoneActionsSheetRef = useRef<HTMLDivElement | null>(null);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);
  const phoneBackRef = useRef<() => void>(() => {});
  const run = useAgentRun(projectKey, reviewerBusy);

  useEffect(() => {
    let cancelled = false;
    void getProject(projectKey)
      .then((next) => {
        if (cancelled) return;
        setLoaded(next);
        setError("");
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, refreshKey, filesRevision]);

  useEffect(() => {
    setTab(null);
    setCodeOpen(false);
    setPhoneView("paper");
    setPage(1);
    setCodePath(null);
    setCodeLines(null);
    setFlash(null);
    setReview(undefined);
    setReviewSeenAt(undefined);
    setAnnotations([]);
    setAnnotationsError("");
    setFocusNote(null);
    setFocusFinding(null);
    setActionsOpen(false);
    setDeleteOpen(false);
    setError("");
  }, [projectKey]);

  useEffect(() => onProjectEvent((event) => {
    if (event.projectKey === projectKey) setFilesRevision((revision) => revision + 1);
  }), [projectKey]);

  useEffect(() => onNavEvent((event) => {
    if (event.type === "pdf_annotations_changed" && event.projectKey === projectKey) {
      setAnnotationsRevision((revision) => revision + 1);
    }
  }), [projectKey]);

  useEffect(() => {
    let cancelled = false;
    void getReview(projectKey)
      .then((next) => {
        if (cancelled) return;
        setReview(next);
        setReviewError("");
        // Only changes made while the paper is open earn the dot.
        setReviewSeenAt((seen) => (seen === undefined ? (next?.updatedAt ?? null) : seen));
      })
      .catch((cause: unknown) => {
        if (!cancelled) setReviewError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, filesRevision]);

  useEffect(() => {
    let cancelled = false;
    void readPdfAnnotations(projectKey)
      .then((items) => {
        if (cancelled) return;
        setAnnotations(items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setAnnotationsError(errorText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, annotationsRevision]);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const hasPdf = project !== null && project.paperPath !== null;

  const showTab = useCallback((next: ProjectTab) => {
    if (next === "code") setCodeOpen(true);
    setTab(next);
    setPhoneView(next);
  }, []);

  const closeCode = useCallback(() => {
    setCodeOpen(false);
    setTab((current) => (current === "code" ? null : current));
    setPhoneView((current) => (current === "code" ? "review" : current));
  }, []);

  const showPaper = useCallback(() => setPhoneView("paper"), []);

  const openPaperRef = useCallback((nextPage: number, anchor: ReviewPaperAnchor | null) => {
    showPaper();
    setPage(nextPage);
    setFlash(anchor ? { ...anchor, nonce: Date.now() } : null);
  }, [showPaper]);

  const openCodeRef = useCallback((path: string, lines: [number, number]) => {
    showTab("code");
    setCodePath(path);
    setCodeLines(lines);
  }, [showTab]);

  const openFile = useCallback((path: string) => {
    setCodePath(path);
    setCodeLines(null);
  }, []);

  const mutateNotes = useCallback(async <T,>(change: () => Promise<T>): Promise<T> => {
    try {
      const result = await change();
      setAnnotationsError("");
      setAnnotations(await readPdfAnnotations(projectKey));
      return result;
    } catch (cause) {
      setAnnotationsError(errorText(cause));
      throw cause;
    }
  }, [projectKey]);

  const onSelectionAction = useCallback((action: PdfSelectionAction, quote: string, quotePage: number) => {
    void mutateNotes(() => createPdfAnnotation(projectKey, { quote, page: quotePage }))
      .then((created) => {
        if (action === "note") {
          showTab("notes");
          setFocusNote(created.number);
        }
      })
      .catch(() => showTab("notes"));
  }, [mutateNotes, projectKey, showTab]);

  const goToNote = useCallback((annotation: PdfAnnotationDto) => {
    showPaper();
    setPage(annotation.page);
    setFlash(annotation.rects.length > 0
      ? {
        page: annotation.page,
        pageWidth: annotation.pageWidth,
        pageHeight: annotation.pageHeight,
        rects: annotation.rects,
        nonce: Date.now(),
      }
      : null);
  }, [showPaper]);

  const addFindingToNotes = useCallback(async (finding: ReviewFinding) => {
    const note = findingNote(finding);
    const index = finding.refs.findIndex((ref) => "paper" in ref);
    const ref = index >= 0 ? finding.refs[index] : undefined;
    const anchor = index >= 0 ? review?.anchors[`${finding.id}:${index}`] : undefined;
    await mutateNotes(() =>
      ref && "paper" in ref && anchor
        ? createPdfAnnotation(projectKey, { quote: ref.paper.quote, page: anchor.page, note, color: "orange", findingId: finding.id })
        : createPdfAnnotation(projectKey, { page, note, findingId: finding.id })
    );
  }, [mutateNotes, page, projectKey, review]);

  const removeFindingFromNotes = useCallback(async (finding: ReviewFinding) => {
    const numbers = annotations
      .filter((annotation) => annotation.findingId === finding.id)
      .map((annotation) => annotation.number);
    await mutateNotes(async () => {
      for (const number of numbers) await deletePdfAnnotation(projectKey, number);
    });
  }, [annotations, mutateNotes, projectKey]);

  const dismiss = useCallback(async (finding: ReviewFinding) => {
    setReview(await dismissFinding(projectKey, finding.id));
  }, [projectKey]);

  const restore = useCallback(async (id: string) => {
    setReview(await restoreFinding(projectKey, id));
  }, [projectKey]);

  const notedFindings = useMemo(
    () => new Set(annotations.flatMap((annotation) => (annotation.findingId ? [annotation.findingId] : []))),
    [annotations],
  );

  const openFinding = useCallback((findingId: string) => {
    showTab("review");
    setFocusFinding({ id: findingId, nonce: Date.now() });
  }, [showTab]);

  useEffect(() => {
    if (!navigationCommand || navigationCommand.projectKey !== projectKey) return;
    if (navigationCommand.id <= consumedNavigationCommandId.current) return;
    consumedNavigationCommandId.current = navigationCommand.id;

    switch (navigationCommand.type) {
      case "show-overview":
        return;
      case "open-paper":
        showPaper();
        if (navigationCommand.page !== undefined) setPage(navigationCommand.page);
        return;
      case "open-code-file":
        showTab("code");
        setCodePath(navigationCommand.path);
        setCodeLines(navigationCommand.lines ?? null);
        return;
      case "set-viewer-page":
        showPaper();
        setPage((current) => Math.max(1, navigationCommand.page ?? (
          navigationCommand.direction === "prev" ? current - 1 : current + 1
        )));
        return;
      case "show-tab":
        if (navigationCommand.tab === "notes" && project?.paperPath === null) return;
        showTab(navigationCommand.tab);
        return;
      case "open-project-actions":
        if (phone) setActionsOpen(true);
        return;
      case "close-project-actions":
        if (phone) setActionsOpen(false);
        return;
      case "navigate-back":
        if (phone) phoneBackRef.current();
        return;
    }
  }, [navigationCommand, phone, project, projectKey, showPaper, showTab]);

  useEffect(() => {
    if (!actionsOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (actionsMenuRef.current?.contains(target)) return;
      if (phoneActionsSheetRef.current?.contains(target)) return;
      setActionsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [actionsOpen]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const host = splitRef.current;
      if (!dragging.current || !host) return;
      const rect = host.getBoundingClientRect();
      setSplit(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (event.clientX - rect.left) / rect.width)));
    };
    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const currentTab: ProjectTab = tab ?? "review";
  const activeTab: ProjectTab = phone ? (phoneView === "paper" ? currentTab : phoneView) : currentTab;
  const htmlOpen = !phone && activeTab === "code" && codePath !== null && /\.html?$/i.test(codePath);
  const sideWide = wide && htmlOpen;
  useEffect(() => {
    if (!htmlOpen) setWide(false);
  }, [htmlOpen]);
  const sideVisible = !phone || phoneView !== "paper";
  const paperVisible = !phone || phoneView === "paper";
  const reviewVisible = sideVisible && activeTab === "review";
  const reviewUnseen = !reviewVisible && review != null && reviewSeenAt !== undefined && review.updatedAt !== reviewSeenAt;

  useEffect(() => {
    if (reviewVisible && review) setReviewSeenAt(review.updatedAt);
  }, [reviewVisible, review]);

  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;
  const viewText = (() => {
    const where = `project "${project?.title ?? projectKey}"`;
    const side = !sideVisible
      ? null
      : activeTab === "code"
        ? (codePath ? `the code file "${codePath}" in the Code tab` : "the code tree in the Code tab")
        : activeTab === "notes"
          ? "the Notes tab"
          : activeTab === "chat"
            ? "the Chat tab"
            : "the Findings tab";
    const parts = [paperVisible ? `the PDF at page ${page}` : null, side].filter(Boolean);
    return `in ${where}, looking at ${parts.join(" and ")}`;
  })();
  useEffect(() => {
    onViewChangeRef.current?.(viewText);
  }, [viewText]);

  function phoneBack() {
    if (actionsOpen) {
      setActionsOpen(false);
      return;
    }
    if (deleteOpen) {
      setDeleteOpen(false);
      return;
    }
    if (phoneView === "code" && codePath) {
      setCodePath(null);
      return;
    }
    if (phoneView !== "paper") {
      setPhoneView("paper");
      return;
    }
    onGoHome();
  }
  phoneBackRef.current = phoneBack;

  if (!project) {
    return <div className={`loading${phone ? " phone-loading" : ""}`}>{error || "loading…"}</div>;
  }

  const paper = (
    <div className="paper-pane">
      {project.paperPath !== null ? (
        <PaperViewer
          projectKey={projectKey}
          path={project.paperPath}
          page={page}
          annotations={annotations}
          flash={flash}
          onPageChange={setPage}
          onSelectionAction={onSelectionAction}
          onSettledView={onTileSettled}
          onDismissedView={onTileDismissed}
        />
      ) : null}
    </div>
  );
  const sideBody = activeTab === "code" ? (
    <CodeWorkspace
      projectKey={projectKey}
      path={codePath}
      lines={codeLines}
      revision={filesRevision}
      phone={phone}
      onOpenFile={openFile}
      onBackToList={() => setCodePath(null)}
      onSettledView={onTileSettled}
      onDismissedView={onTileDismissed}
    />
  ) : activeTab === "chat" ? (
    chat
  ) : activeTab === "notes" ? (
    <NotesPanel
      projectKey={projectKey}
      annotations={annotations}
      findings={review?.document?.findings ?? []}
      page={page}
      error={annotationsError}
      focusNumber={focusNote}
      onFocusHandled={() => setFocusNote(null)}
      onGo={goToNote}
      onOpenFinding={openFinding}
      onSetNote={async (number, note) => {
        await mutateNotes(() => setPdfAnnotationNote(projectKey, number, note));
      }}
      onDelete={(number) => void mutateNotes(() => deletePdfAnnotation(projectKey, number)).catch(() => undefined)}
      onAddPageNote={async (notePage, note) => {
        await mutateNotes(() => createPdfAnnotation(projectKey, { page: notePage, note }));
      }}
    />
  ) : (
    <ReviewPanel
      projectKey={projectKey}
      review={review}
      error={reviewError}
      agent={reviewerBusy ? <AgentRow projectKey={projectKey} run={run} /> : null}
      canNote={hasPdf}
      notedFindings={notedFindings}
      focusFinding={focusFinding}
      onPaperRef={openPaperRef}
      onCodeRef={openCodeRef}
      onAddToNotes={addFindingToNotes}
      onRemoveFromNotes={removeFindingFromNotes}
      onDismiss={dismiss}
      onRestore={restore}
    />
  );

  const live = <span className="side-tab-live" role="img" aria-label="working" title="Working" />;

  const side = (
    <div className="side-pane">
      {phone ? null : <div className="side-tabs" role="tablist" aria-label="Findings, notes and chat">
        <SideTab
          label="Findings"
          on={activeTab === "review"}
          icon={(
            <span className="side-tab-icon is-review" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.4-4.4" /></svg>
            </span>
          )}
          meta={reviewerBusy ? live : reviewUnseen ? <span className="side-tab-dot" aria-label="updated" /> : null}
          onSelect={() => showTab("review")}
        />
        {hasPdf ? (
          <SideTab
            label="Notes"
            on={activeTab === "notes"}
            icon={(
              <span className="side-tab-icon is-notes" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
              </span>
            )}
            onSelect={() => showTab("notes")}
          />
        ) : null}
        {chat ? (
          <SideTab
            label="Chat"
            on={activeTab === "chat"}
            icon={(
              <span className="side-tab-icon is-chat" aria-hidden="true">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" /></svg>
              </span>
            )}
            onSelect={() => showTab("chat")}
          />
        ) : null}
        {codeOpen ? (
          <SideTab
            label={codePath ? fileName(codePath) : "Code"}
            on={activeTab === "code"}
            icon={<span className="side-tab-icon is-code" aria-hidden="true">{"</>"}</span>}
            onSelect={() => showTab("code")}
            onClose={closeCode}
          />
        ) : null}
        {htmlOpen ? (
          <button
            type="button"
            className="side-tabs-expand"
            aria-pressed={sideWide}
            aria-label={sideWide ? "Show PDF" : "Expand"}
            title={sideWide ? "Show PDF" : "Expand"}
            onClick={() => setWide(!sideWide)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {sideWide
                ? <><path d="M4 14h6v6" /><path d="M20 10h-6V4" /><path d="m14 10 7-7" /><path d="m3 21 7-7" /></>
                : <><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /></>}
            </svg>
          </button>
        ) : null}
      </div>}
      <div className="side-tab-body">{sideBody}</div>
      {bar}
    </div>
  );

  return (
    <div className={`project-workspace canvas-shell review-shell${phone ? " phone-shell" : ""}`}>
      <header className="context-strip">
        <div className="context-strip-brand">
          {phone ? (
            <button
              type="button"
              className="rail-toggle phone-back"
              onClick={phoneBack}
              aria-label="Back"
              title="Back"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m14 6-6 6 6 6" />
              </svg>
            </button>
          ) : (
            <nav className="context-strip-crumbs" aria-label="Breadcrumb">
              <button type="button" className="context-strip-crumb" onClick={onGoHome}>
                Home
              </button>
              <span className="context-strip-crumb-sep" aria-hidden="true">/</span>
            </nav>
          )}
          <span className="context-strip-title">
            <span className="context-strip-title-text">{project.title}</span>
          </span>
        </div>
        <div className="context-strip-trail" />
        <div className="context-strip-actions" ref={actionsMenuRef}>
          {phone ? (
            <div className="review-panel-toggles" role="group" aria-label="View">
              {(["paper", "review", "notes"] as const)
                .filter((view) => view !== "notes" || hasPdf)
                .map((view) => (
                <button
                  key={view}
                  type="button"
                  className={`review-panel-toggle${phoneView === view ? " on" : ""}`}
                  aria-pressed={phoneView === view}
                  onClick={() => (view === "paper" ? showPaper() : showTab(view))}
                >
                  {view === "paper" ? "PDF" : view === "review" ? "Findings" : "Notes"}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            className="secondary project-actions-trigger project-actions-kebab"
            aria-expanded={actionsOpen}
            aria-haspopup="menu"
            aria-label="More actions"
            title="More actions"
            onClick={() => setActionsOpen((value) => !value)}
          >
            <svg className="project-actions-more" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
              <circle cx="12" cy="5.5" r="1.4" />
              <circle cx="12" cy="12" r="1.4" />
              <circle cx="12" cy="18.5" r="1.4" />
            </svg>
          </button>
          {actionsOpen && !phone ? (
            <div className="project-actions-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setActionsOpen(false);
                  showTab("code");
                }}
              >
                Browse code
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setActionsOpen(false);
                  onOpenAccount();
                }}
              >
                Account
              </button>
              <button
                type="button"
                role="menuitem"
                className="project-actions-danger"
                onClick={() => {
                  setActionsOpen(false);
                  setDeleteOpen(true);
                }}
              >
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {error && <div className="form-error">{error}</div>}

      {phone ? (
        <div className="review-body is-phone">{phoneView === "paper" ? paper : side}</div>
      ) : (
        <div className="review-stage">
          <div
            className={`review-body${sideWide ? " is-wide" : ""}`}
            ref={splitRef}
            style={{
              gridTemplateColumns: sideWide
                ? "minmax(0, 1fr)"
                : `minmax(0, ${split}fr) ${SPLITTER_PX}px minmax(0, ${1 - split}fr)`,
            }}
          >
            <div className="review-panel is-paper">{paper}</div>
            <div
              className="review-splitter"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panels"
              onPointerDown={startDrag}
            />
            <div className="review-panel is-side">{side}</div>
          </div>
        </div>
      )}

      {deleteOpen && (
        <DeleteProjectDialog
          project={project}
          onClose={() => setDeleteOpen(false)}
          onDeleted={onDeleted}
        />
      )}
      {phone && actionsOpen
        ? createPortal(
            <div className="phone-actions-layer">
              <button
                type="button"
                className="phone-actions-backdrop"
                aria-label="Dismiss"
                onClick={() => setActionsOpen(false)}
              />
              <div className="phone-actions-sheet" role="menu" ref={phoneActionsSheetRef}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setActionsOpen(false);
                    showTab("code");
                  }}
                >
                  Browse code
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="project-actions-danger"
                  onClick={() => {
                    setActionsOpen(false);
                    setDeleteOpen(true);
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="phone-actions-cancel"
                  onClick={() => setActionsOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
