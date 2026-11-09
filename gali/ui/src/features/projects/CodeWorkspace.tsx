import { useCallback, useEffect, useRef, useState } from "react";
import { fileName } from "./file-kind";
import { ProjectFilesTree } from "./ProjectFilesTree";
import { SourceFileViewer } from "./SourceFileViewer";

const EXPLORER_MIN = 160;
const EXPLORER_MAX = 480;
const EXPLORER_DEFAULT = 240;
const SCROLL_QUANTIZE = 16;
const SCROLL_SETTLE_MS = 280;

function scrollKeyOf(el: HTMLElement): string {
  const quantize = (n: number) => String(Math.round(n / SCROLL_QUANTIZE) * SCROLL_QUANTIZE);
  return `${quantize(el.scrollTop)}:${quantize(el.scrollLeft)}`;
}

function CodeFileView({
  projectKey,
  path,
  revision,
  lines,
  onSettledView,
  onDismissedView,
}: {
  projectKey: string;
  path: string;
  revision: number;
  lines: [number, number] | null;
  onSettledView?: (target: { path: string; page: number }) => void;
  onDismissedView?: () => void;
}) {
  // data-tile-ready is polled by view-capture.ts before snapshotting for the model
  const [viewState, setViewState] = useState<"loading" | "ready" | "av">("loading");
  const [scrollKey, setScrollKey] = useState("0:0");
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const identity = `${path}:${revision}`;
  const [lastIdentity, setLastIdentity] = useState(identity);
  if (lastIdentity !== identity) {
    setLastIdentity(identity);
    setViewState("loading");
    setScrollKey("0:0");
  }

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = 0;
    el.scrollLeft = 0;
    let timer = 0;
    const onScroll = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setScrollKey(scrollKeyOf(el)), SCROLL_SETTLE_MS);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener("scroll", onScroll);
    };
  }, [identity]);

  useEffect(() => {
    if (viewState === "ready") onSettledView?.({ path, page: 1 });
  }, [viewState, path, scrollKey, onSettledView]);

  useEffect(() => () => onDismissedView?.(), [onDismissedView]);

  const onViewState = useCallback((state: "loading" | "ready" | "av") => setViewState(state), []);

  return (
    <section
      className="code-file-view"
      aria-label={`File ${path}`}
      data-tile-capture="true"
      data-tile-kind="code"
      data-tile-path={path}
      data-tile-page="1"
      data-tile-scroll={scrollKey}
      data-tile-ready={viewState}
    >
      <div className="code-file-view-body" ref={bodyRef}>
        <SourceFileViewer
          projectKey={projectKey}
          path={path}
          revision={revision}
          lines={lines}
          onViewState={onViewState}
        />
      </div>
    </section>
  );
}

export function CodeWorkspace({
  projectKey,
  path,
  lines = null,
  revision,
  phone = false,
  onOpenFile,
  onBackToList,
  onSettledView,
  onDismissedView,
}: {
  projectKey: string;
  path: string | null;
  /** First and last line to scroll to and mark in the open file. */
  lines?: [number, number] | null;
  /** Bumps when files may have changed on disk. */
  revision: number;
  phone?: boolean;
  onOpenFile: (path: string) => void;
  onBackToList: () => void;
  onSettledView?: (target: { path: string; page: number }) => void;
  onDismissedView?: () => void;
}) {
  const [explorerWidth, setExplorerWidth] = useState(EXPLORER_DEFAULT);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setExplorerWidth(Math.min(
        EXPLORER_MAX,
        Math.max(EXPLORER_MIN, drag.startWidth + (event.clientX - drag.startX)),
      ));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
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

  function startDrag(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    dragRef.current = { startX: event.clientX, startWidth: explorerWidth };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const explorer = (
    <aside className="code-explorer">
      <div className="code-explorer-head">
        <span className="code-explorer-label">Files</span>
        <span className="code-workspace-meta">read only</span>
      </div>
      <ProjectFilesTree
        projectKey={projectKey}
        revision={revision}
        selectedPath={path}
        onOpenFile={onOpenFile}
        dense
      />
    </aside>
  );

  const file = path ? (
    <CodeFileView
      projectKey={projectKey}
      path={path}
      revision={revision}
      lines={lines}
      onSettledView={onSettledView}
      onDismissedView={onDismissedView}
    />
  ) : (
    <div className="code-editor-empty">Select a file in the explorer.</div>
  );

  if (phone) {
    return (
      <section className={`code-workspace phone-code ${path ? "phone-code-file" : "phone-code-list"}`} aria-label="Code">
        {path ? (
          <div className="code-editor-pane">
            <div className="phone-code-file-bar">
              <button type="button" className="phone-code-file-back" onClick={onBackToList} aria-label="Back to files">‹</button>
              <span className="phone-code-file-name">{fileName(path)}</span>
            </div>
            {file}
          </div>
        ) : explorer}
      </section>
    );
  }

  return (
    <section className="code-workspace" aria-label="Code">
      <div
        className="code-workspace-split"
        style={{ gridTemplateColumns: `${explorerWidth}px 1px minmax(0, 1fr)` }}
      >
        {explorer}
        <div
          className="code-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize explorer"
          onPointerDown={startDrag}
        />
        <div className="code-editor-pane">{file}</div>
      </div>
    </section>
  );
}
