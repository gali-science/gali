import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type {
  ReviewDocument,
  ReviewFinding,
  ReviewPaperAnchor,
  ReviewRef,
  ReviewSeverity,
  ReviewVisual,
} from "../../../../shared/domain/contracts";
import { onProjectEvent, readProjectMedia, type ReviewDto } from "../../api";
import { IconBookmark, IconClose, IconCode, IconPage } from "../../app/icons";
import { Markdown } from "../../Markdown";
import { PanelEmpty } from "../../PanelEmpty";
import { fileName } from "./file-kind";

const SEVERITY_LABEL: Record<ReviewSeverity, string> = { serious: "Serious", minor: "Minor", ok: "Checked", study: "Study" };
const SERIES_COLORS = ["#FC4C02", "#162637", "#178255", "#0A84FF", "#8B5CF6", "#98A0B3"];

function lineLabel([first, last]: [number, number]): string {
  return first === last ? String(first) : `${first}–${last}`;
}

type PaperChip = {
  page: number;
  place: string | undefined;
  anchor: ReviewPaperAnchor | null;
  passages: Array<{ quote: string; found: boolean }>;
};
type RefChip = { paper: PaperChip } | { code: { path: string; lines: [number, number] } };

function refChips(finding: ReviewFinding, anchors: ReviewDto["anchors"]): RefChip[] {
  const chips: RefChip[] = [];
  finding.refs.forEach((ref: ReviewRef, index) => {
    if ("code" in ref) {
      chips.push(ref);
      return;
    }
    const anchor = anchors[`${finding.id}:${index}`] ?? null;
    const page = anchor?.page ?? ref.paper.page;
    const place = ref.paper.place;
    let chip = chips.find((item): item is { paper: PaperChip } =>
      "paper" in item && item.paper.page === page && item.paper.place === place)?.paper;
    if (!chip) {
      chip = { page, place, anchor: null, passages: [] };
      chips.push({ paper: chip });
    }
    chip.passages.push({ quote: ref.paper.quote, found: anchor !== null });
    if (anchor) chip.anchor = chip.anchor ? { ...chip.anchor, rects: [...chip.anchor.rects, ...anchor.rects] } : anchor;
  });
  return chips;
}

export function reviewMarkdown(document: ReviewDocument): string {
  const blocks = [`# ${document.title}`];
  for (const finding of document.findings) {
    const where = finding.refs.map((ref) =>
      "paper" in ref
        ? `p. ${ref.paper.page} ("${ref.paper.quote}")`
        : `${ref.code.path}:${lineLabel(ref.code.lines)}`
    );
    blocks.push(
      `## ${finding.title} (${SEVERITY_LABEL[finding.severity].toLowerCase()})`,
      finding.body,
      ...(where.length > 0 ? [`Where: ${where.join("; ")}`] : []),
    );
  }
  return `${blocks.join("\n\n")}\n`;
}

type CachedMedia = { seq: number; url: Promise<string>; shown: string | null };

const mediaCache = new Map<string, CachedMedia>();
const latestSeq = new Map<string, number>();
const seqListeners = new Set<() => void>();
let watchingProjects = false;

/** Figures are shared across panels and remounts; a project event means files changed, so they are fetched again. */
function watchProjects() {
  if (watchingProjects) return;
  watchingProjects = true;
  onProjectEvent((event) => {
    latestSeq.set(event.projectKey, Math.max(event.seq, latestSeq.get(event.projectKey) ?? 0));
    for (const listener of seqListeners) listener();
  });
}

function mediaKey(projectKey: string, path: string): string {
  return `${projectKey}\n${path}`;
}

function releaseLater(key: string, url: string) {
  window.setTimeout(() => {
    if (mediaCache.get(key)?.shown !== url) URL.revokeObjectURL(url);
  }, 30_000);
}

function mediaUrl(projectKey: string, path: string, seq: number): Promise<string> {
  const key = mediaKey(projectKey, path);
  const hit = mediaCache.get(key);
  if (hit && hit.seq === seq) return hit.url;
  if (hit) void hit.url.then((url) => releaseLater(key, url), () => undefined);
  const url = readProjectMedia(projectKey, path).then((media) => {
    const bytes = new Uint8Array(media.data.byteLength);
    bytes.set(media.data);
    return URL.createObjectURL(new Blob([bytes.buffer], { type: media.mime }));
  });
  url.catch(() => {
    const entry = mediaCache.get(key);
    if (entry?.url !== url) return;
    mediaCache.delete(key);
    if (entry.shown) releaseLater(key, entry.shown);
  });
  mediaCache.set(key, { seq, url, shown: hit?.shown ?? null });
  return url;
}

function noteMediaShown(projectKey: string, path: string, url: string) {
  const key = mediaKey(projectKey, path);
  const entry = mediaCache.get(key);
  if (!entry || entry.shown === url) return;
  const previous = entry.shown;
  entry.shown = url;
  if (previous) releaseLater(key, previous);
}

function useProjectSeq(projectKey: string): number {
  watchProjects();
  const [seq, setSeq] = useState(() => latestSeq.get(projectKey) ?? 0);
  useEffect(() => {
    const listener = () => setSeq(latestSeq.get(projectKey) ?? 0);
    seqListeners.add(listener);
    listener();
    return () => {
      seqListeners.delete(listener);
    };
  }, [projectKey]);
  return seq;
}

export function Figure({ projectKey, path, caption }: { projectKey: string; path: string; caption: string }) {
  const seq = useProjectSeq(projectKey);
  const [url, setUrl] = useState<string | null>(() => mediaCache.get(mediaKey(projectKey, path))?.shown ?? null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void mediaUrl(projectKey, path, seq)
      .then((next) => {
        if (!cancelled) setUrl(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, path, seq]);
  return (
    <figure className="review-visual review-figure">
      {url ? <img src={url} alt={caption} onLoad={() => noteMediaShown(projectKey, path, url)} /> : <div className="review-figure-empty">{error || "Loading…"}</div>}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

export function Chart({ chart }: { chart: Extract<ReviewVisual, { chart: unknown }>["chart"] }) {
  const width = 560;
  const height = 200;
  const pad = { left: 44, right: 12, top: 12, bottom: 28 };
  const values = chart.series.flatMap((series) => series.values);
  const min = chart.kind === "bar" ? Math.min(0, ...values) : Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const count = chart.x.values.length;
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const y = (value: number) => pad.top + plotHeight - ((value - min) / span) * plotHeight;
  const x = (index: number) => pad.left + (count === 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const slot = plotWidth / count;
  const barWidth = Math.max(2, (slot * 0.7) / chart.series.length);
  const tickEvery = Math.max(1, Math.ceil(count / 8));
  const format = (value: number) => (Math.abs(value) >= 1000 || Number.isInteger(value) ? String(value) : value.toPrecision(3));

  return (
    <figure className="review-visual review-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={chart.caption}>
        <line x1={pad.left} x2={width - pad.right} y1={y(min)} y2={y(min)} className="review-chart-axis" />
        <line x1={pad.left} x2={width - pad.right} y1={y(max)} y2={y(max)} className="review-chart-grid" />
        <text x={pad.left - 6} y={y(max) + 4} textAnchor="end" className="review-chart-tick">{format(max)}</text>
        <text x={pad.left - 6} y={y(min) + 4} textAnchor="end" className="review-chart-tick">{format(min)}</text>
        {chart.x.values.map((label, index) =>
          index % tickEvery === 0 || index === count - 1 ? (
            <text
              key={index}
              x={chart.kind === "bar" ? pad.left + slot * (index + 0.5) : x(index)}
              y={height - 8}
              textAnchor="middle"
              className="review-chart-tick"
            >
              {String(label)}
            </text>
          ) : null
        )}
        {chart.series.map((series, seriesIndex) => {
          const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
          if (chart.kind === "line") {
            return (
              <polyline
                key={series.name}
                fill="none"
                stroke={color}
                strokeWidth={2}
                points={series.values.map((value, index) => `${x(index)},${y(value)}`).join(" ")}
              />
            );
          }
          return series.values.map((value, index) => {
            const left = pad.left + slot * index + slot * 0.15 + barWidth * seriesIndex;
            const top = Math.min(y(value), y(Math.max(min, 0)));
            return (
              <rect
                key={`${series.name}:${index}`}
                x={left}
                y={top}
                width={barWidth}
                height={Math.abs(y(value) - y(Math.max(min, 0)))}
                fill={color}
              />
            );
          });
        })}
      </svg>
      <figcaption>
        <span>{chart.caption}</span>
        <span className="review-chart-legend">
          {chart.series.map((series, index) => (
            <span key={series.name}>
              <i style={{ background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
              {series.name}
            </span>
          ))}
          <span className="review-chart-x">x: {chart.x.label}</span>
        </span>
      </figcaption>
    </figure>
  );
}

export function Visual({ projectKey, visual }: { projectKey: string; visual: ReviewVisual }) {
  if ("figure" in visual) return <Figure projectKey={projectKey} {...visual.figure} />;
  if ("chart" in visual) return <Chart chart={visual.chart} />;
  return (
    <figure className="review-visual review-table">
      <div className="review-table-scroll">
        <table>
          <thead>
            <tr>{visual.table.columns.map((column, index) => <th key={index}>{column}</th>)}</tr>
          </thead>
          <tbody>
            {visual.table.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption>{visual.table.caption}</figcaption>
    </figure>
  );
}

function Finding({
  projectKey,
  finding,
  anchors,
  canNote,
  inNotes,
  onPaperRef,
  onCodeRef,
  onAddToNotes,
  onRemoveFromNotes,
  onDismiss,
}: {
  projectKey: string;
  finding: ReviewFinding;
  anchors: ReviewDto["anchors"];
  canNote: boolean;
  inNotes: boolean;
  onPaperRef: (page: number, anchor: ReviewPaperAnchor | null) => void;
  onCodeRef: (path: string, lines: [number, number]) => void;
  onAddToNotes: (finding: ReviewFinding) => Promise<void>;
  onRemoveFromNotes: (finding: ReviewFinding) => Promise<void>;
  onDismiss: (finding: ReviewFinding) => Promise<void>;
}) {
  const [pending, setPending] = useState<"add" | "remove" | "dismiss" | null>(null);
  const [actionError, setActionError] = useState("");

  async function act(kind: "add" | "remove" | "dismiss", action: (finding: ReviewFinding) => Promise<void>) {
    setPending(kind);
    setActionError("");
    try {
      await action(finding);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }

  return (
    <article className={`review-finding is-${finding.severity}`} id={`review-${finding.id}`}>
      <header className="review-finding-head">
        <span className={`review-severity is-${finding.severity}`}>{SEVERITY_LABEL[finding.severity]}</span>
        <h3>{finding.title}</h3>
      </header>
      <div className="review-finding-body"><Markdown compact>{finding.body}</Markdown></div>
      {finding.visuals.map((visual, index) => <Visual key={index} projectKey={projectKey} visual={visual} />)}
      <footer className="review-finding-actions">
        {refChips(finding, anchors).map((chip, index) => {
          if ("code" in chip) {
            const { path, lines } = chip.code;
            return (
              <button key={index} type="button" className="review-ref" title={path} onClick={() => onCodeRef(path, lines)}>
                <IconCode />
                <code>{`${fileName(path)}:${lineLabel(lines)}`}</code>
              </button>
            );
          }
          const { page, place, anchor, passages } = chip.paper;
          return (
            <button
              key={index}
              type="button"
              className={`review-ref${anchor ? "" : " is-broken"}`}
              title={passages.map(({ quote, found }) => `${found ? "" : "Passage not found. "}“${quote}”`).join("\n")}
              onClick={() => onPaperRef(page, anchor)}
            >
              <IconPage />
              {place ? <>{place}{" "}<span className="review-ref-page">{`p. ${page}`}</span></> : `p. ${page}`}
            </button>
          );
        })}
        {actionError ? <span className="review-finding-error">{actionError}</span> : null}
        <div className="review-finding-buttons">
          {inNotes ? (
            <span className="review-note-slot">
              <span className="review-note is-kept review-note-sizer" aria-hidden="true">
                <IconBookmark filled />
                Remove from notes
              </span>
              <button
                type="button"
                className="review-note is-kept"
                aria-label={pending === "remove" ? undefined : "Remove from notes"}
                disabled={pending !== null}
                onClick={() => void act("remove", onRemoveFromNotes)}
              >
                <IconBookmark filled />
                {pending === "remove" ? "Removing…" : (
                  <>
                    <span className="review-note-rest" aria-hidden="true">In notes</span>
                    <span className="review-note-hover" aria-hidden="true">Remove from notes</span>
                  </>
                )}
              </button>
            </span>
          ) : finding.severity === "ok" || !canNote ? null : (
            <button type="button" className="review-note" disabled={pending !== null} onClick={() => void act("add", onAddToNotes)}>
              <IconBookmark />
              {pending === "add" ? "Adding…" : "Add to notes"}
            </button>
          )}
          <button
            type="button"
            className="review-dismiss"
            aria-label={pending === "dismiss" ? "Dismissing…" : "Dismiss as not important"}
            data-tip="Dismiss as not important"
            disabled={pending !== null}
            onClick={() => void act("dismiss", onDismiss)}
          >
            <IconClose />
          </button>
        </div>
      </footer>
    </article>
  );
}

function DismissedItem({ title, onRestore }: { title: string; onRestore: () => Promise<void> }) {
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");

  async function restore() {
    setRestoring(true);
    setError("");
    try {
      await onRestore();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setRestoring(false);
    }
  }

  return (
    <div className="review-dismissed-item">
      <span className="review-dismissed-title">{title}</span>
      {error ? <span className="review-finding-error">{error}</span> : null}
      <button type="button" className="review-finding-link" disabled={restoring} onClick={() => void restore()}>
        {restoring ? "Restoring…" : "Restore"}
      </button>
    </div>
  );
}

/** The note text "Add to notes" writes for a finding. */
export function findingNote(finding: ReviewFinding): string {
  return `${finding.title}. ${finding.body}`;
}

/** Scrolls to an element in the review and flashes it, so the eye lands on it. */
function scrollToSection(container: HTMLElement | null, id: string) {
  const target = container?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!target) return;
  const folded = target.closest("details");
  if (folded) folded.open = true;
  target.scrollIntoView({ block: "start", behavior: "smooth" });
  target.classList.remove("is-focused");
  void target.offsetWidth;
  target.classList.add("is-focused");
}

// Following a code ref swaps the review out; coming back lands where the reader was.
const savedScroll = new Map<string, number>();

export function ReviewPanel({
  projectKey,
  review,
  error,
  agent = null,
  canNote = true,
  notedFindings,
  focusFinding,
  onPaperRef,
  onCodeRef,
  onAddToNotes,
  onRemoveFromNotes,
  onDismiss,
  onRestore,
}: {
  projectKey: string;
  /** Undefined while loading; null when the reviewer has not written review.json. */
  review: ReviewDto | null | undefined;
  error: string;
  agent?: ReactNode;
  canNote?: boolean;
  notedFindings: ReadonlySet<string>;
  /** Scroll to this finding once the review is shown; the nonce repeats a jump to the same one. */
  focusFinding: { id: string; nonce: number } | null;
  onPaperRef: (page: number, anchor: ReviewPaperAnchor | null) => void;
  onCodeRef: (path: string, lines: [number, number]) => void;
  onAddToNotes: (finding: ReviewFinding) => Promise<void>;
  onRemoveFromNotes: (finding: ReviewFinding) => Promise<void>;
  onDismiss: (finding: ReviewFinding) => Promise<void>;
  onRestore: (id: string) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const loaded = review !== undefined;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !loaded) return;
    el.scrollTop = savedScroll.get(projectKey) ?? 0;
    const onScroll = () => savedScroll.set(projectKey, el.scrollTop);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [projectKey, loaded]);

  const hasDocument = Boolean(review?.document);
  useEffect(() => {
    if (focusFinding && hasDocument) scrollToSection(scrollRef.current, `review-${focusFinding.id}`);
  }, [focusFinding, hasDocument]);

  const document = review?.document ?? null;
  const dismissed = review?.dismissed ?? [];
  const dismissedIds = new Set(dismissed.map((item) => item.id));
  const shown = document?.findings.filter((finding) => !dismissedIds.has(finding.id)) ?? [];
  const serious = shown.filter((finding) => finding.severity === "serious");
  const minor = shown.filter((finding) => finding.severity === "minor");
  const checked = shown.filter((finding) => finding.severity === "ok");
  const study = shown.filter((finding) => finding.severity === "study");
  const finding = (item: ReviewFinding) => (
    <Finding
      key={item.id}
      projectKey={projectKey}
      finding={item}
      anchors={review?.anchors ?? {}}
      canNote={canNote}
      inNotes={notedFindings.has(item.id)}
      onPaperRef={onPaperRef}
      onCodeRef={onCodeRef}
      onAddToNotes={onAddToNotes}
      onRemoveFromNotes={onRemoveFromNotes}
      onDismiss={onDismiss}
    />
  );

  async function copy() {
    if (!document) return;
    await navigator.clipboard.writeText(reviewMarkdown({ ...document, findings: shown }));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <section className="tile-viewer review-panel-view" aria-label="Findings">
      {document || agent ? (
        <header className="tile-viewer-head">
          {agent}
          {document ? (
            <div className="tile-viewer-actions">
              <button type="button" className="panel-action" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy as text"}
              </button>
            </div>
          ) : null}
        </header>
      ) : null}
      <div className="review-doc-scroll" ref={scrollRef}>
        {error ? <div className="form-error">{error}</div> : null}
        {review === undefined && !error ? <p className="code-preview-loading">Loading…</p> : null}
        {review === null ? <PanelEmpty icon="review" label="No findings yet" /> : null}
        {review && review.problems.length > 0 ? (
          <details className="review-problems">
            <summary>
              {document ? `${review.problems.length} part${review.problems.length > 1 ? "s" : ""} of the findings could not be checked` : "The findings could not be read"}
            </summary>
            <ul>{review.problems.map((problem, index) => <li key={index}>{problem}</li>)}</ul>
          </details>
        ) : null}
        {document ? (
          <div className="review-doc">
            {serious.length > 0 ? (
              <section className="review-group is-findings" aria-labelledby="review-findings-title">
                <header className="review-group-head">
                  <span className="review-group-icon" aria-hidden="true">!</span>
                  <div>
                    <h2 id="review-findings-title">Could change a conclusion</h2>
                    <p>The most serious problems Gali found. It may have missed others.</p>
                  </div>
                </header>
                {serious.map(finding)}
              </section>
            ) : null}
            {minor.length > 0 ? (
              <section className="review-group is-minor" aria-labelledby="review-minor-title">
                <header className="review-group-head">
                  <span className="review-group-icon" aria-hidden="true">~</span>
                  <div>
                    <h2 id="review-minor-title">Worth fixing</h2>
                    <p>{`${minor.length} minor issue${minor.length > 1 ? "s" : ""}: wrong, but the conclusions stand.`}</p>
                  </div>
                </header>
                {minor.map((item) => (
                  <details key={item.id} className="review-minor">
                    <summary>{item.title}</summary>
                    {finding(item)}
                  </details>
                ))}
              </section>
            ) : null}
            {checked.length > 0 ? (
              <section className="review-group is-confirmed" aria-labelledby="review-confirmed-title">
                <header className="review-group-head">
                  <span className="review-group-icon" aria-hidden="true">✓</span>
                  <div>
                    <h2 id="review-confirmed-title">What holds up</h2>
                    <p>Claims Gali checked against the PDF and code and found correct.</p>
                  </div>
                </header>
                {checked.map(finding)}
              </section>
            ) : null}
            {study.length > 0 ? (
              <section className="review-group is-study" aria-labelledby="review-study-title">
                <header className="review-group-head">
                  <span className="review-group-icon" aria-hidden="true">?</span>
                  <div>
                    <h2 id="review-study-title">To study</h2>
                    <p>Practice problems and worked examples Gali made from this PDF.</p>
                  </div>
                </header>
                {study.map(finding)}
              </section>
            ) : null}
            {dismissed.length > 0 ? (
              <details className="review-dismissed">
                <summary>Dismissed</summary>
                <p className="review-dismissed-hint">Gali will not bring these up again.</p>
                {dismissed.map((item) => <DismissedItem key={item.id} title={item.title} onRestore={() => onRestore(item.id)} />)}
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
