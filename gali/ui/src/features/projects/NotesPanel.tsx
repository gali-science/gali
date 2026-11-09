import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ReviewFinding, ReviewVisual } from "../../../../shared/domain/contracts";
import type { PdfAnnotationDto } from "../../api";
import { canDownload, downloadPdfAnnotations } from "../../downloads";
import { Markdown } from "../../Markdown";
import { PanelEmpty } from "../../PanelEmpty";
import { Visual } from "./ReviewPanel";

function NoteItem({
  projectKey,
  annotation,
  visuals,
  editing,
  onEdit,
  onGo,
  onOpenFinding,
  onSave,
  onDelete,
}: {
  projectKey: string;
  annotation: PdfAnnotationDto;
  visuals: readonly ReviewVisual[];
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onGo: () => void;
  onOpenFinding?: () => void;
  onSave: (note: string) => Promise<void>;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(annotation.note ?? "");
  const [saving, setSaving] = useState(false);
  const itemRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(annotation.note ?? "");
    itemRef.current?.scrollIntoView({ block: "nearest" });
    inputRef.current?.focus();
  }, [editing, annotation.note]);

  async function save() {
    if ((annotation.note ?? "") === draft.trim()) {
      onEdit(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      onEdit(false);
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onEdit(false);
    }
  }

  return (
    <article className={`note-item is-${annotation.color}${editing ? " is-editing" : ""}`} ref={itemRef}>
      {annotation.quote ? (
        <button type="button" className="note-item-quote" onClick={onGo} title="Show in the PDF">
          {annotation.quote}
        </button>
      ) : null}
      {editing ? (
        <textarea
          ref={inputRef}
          className="note-item-input"
          value={draft}
          rows={Math.min(8, Math.max(2, draft.split("\n").length))}
          placeholder="Write a note"
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => void save()}
        />
      ) : annotation.note ? (
        <div className="note-item-text" onClick={() => onEdit(true)}><Markdown compact>{annotation.note}</Markdown></div>
      ) : (
        <button type="button" className="note-item-add" onClick={() => onEdit(true)}>Add a note</button>
      )}
      {visuals.map((visual, index) => <Visual key={index} projectKey={projectKey} visual={visual} />)}
      <footer className="note-item-meta">
        <button type="button" className="note-item-go" onClick={onGo}>
          #{annotation.number} · p. {annotation.page}
        </button>
        {onOpenFinding ? (
          <button type="button" className="note-item-finding" onClick={onOpenFinding}>
            See in Findings
          </button>
        ) : null}
        <span className="note-item-spacer" />
        {!editing ? (
          <button type="button" className="note-item-action" onClick={() => onEdit(true)}>Edit</button>
        ) : null}
        <button type="button" className="note-item-action is-danger" onClick={onDelete}>Delete</button>
      </footer>
    </article>
  );
}

export function NotesPanel({
  projectKey,
  annotations,
  findings,
  page,
  error,
  focusNumber,
  onFocusHandled,
  onGo,
  onOpenFinding,
  onSetNote,
  onDelete,
  onAddPageNote,
}: {
  projectKey: string;
  annotations: readonly PdfAnnotationDto[];
  findings: readonly ReviewFinding[];
  page: number;
  error: string;
  focusNumber: number | null;
  onFocusHandled: () => void;
  onGo: (annotation: PdfAnnotationDto) => void;
  onOpenFinding: (findingId: string) => void;
  onSetNote: (number: number, note: string) => Promise<void>;
  onDelete: (number: number) => void;
  onAddPageNote: (page: number, note: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<"mine" | "review">("mine");

  useEffect(() => {
    if (focusNumber === null) return;
    const focused = annotations.find((annotation) => annotation.number === focusNumber);
    if (!focused) return;
    setView(focused.findingId ? "review" : "mine");
    setEditing(focusNumber);
    onFocusHandled();
  }, [focusNumber, annotations, onFocusHandled]);

  async function add() {
    const text = draft.trim();
    if (!text || adding) return;
    setAdding(true);
    try {
      await onAddPageNote(page, text);
      setDraft("");
    } finally {
      setAdding(false);
    }
  }

  const mine = annotations.filter((annotation) => !annotation.findingId);
  const fromReview = annotations.filter((annotation) => annotation.findingId);
  const shown = view === "mine" ? mine : fromReview;
  const pages = [...new Set(shown.map((annotation) => annotation.page))].sort((a, b) => a - b);

  const item = (annotation: PdfAnnotationDto) => {
    const findingId = annotation.findingId;
    return (
      <NoteItem
        key={annotation.number}
        projectKey={projectKey}
        annotation={annotation}
        visuals={findingId ? findings.find((finding) => finding.id === findingId)?.visuals ?? [] : []}
        editing={editing === annotation.number}
        onEdit={(next) => setEditing(next ? annotation.number : null)}
        onGo={() => onGo(annotation)}
        {...(findingId ? { onOpenFinding: () => onOpenFinding(findingId) } : {})}
        onSave={(note) => onSetNote(annotation.number, note)}
        onDelete={() => onDelete(annotation.number)}
      />
    );
  };

  return (
    <section className="notes-panel" aria-label="Notes">
      <div className="notes-head">
        <div className="notes-subtabs" role="tablist" aria-label="Notes">
          <button type="button" role="tab" aria-selected={view === "mine"} onClick={() => setView("mine")}>
            Your notes
          </button>
          <button type="button" role="tab" aria-selected={view === "review"} onClick={() => setView("review")}>
            Saved findings
          </button>
        </div>
        {annotations.length > 0 && canDownload() ? (
          <div className="notes-downloads">
            <button type="button" className="panel-action" onClick={() => downloadPdfAnnotations(projectKey, "markdown")}>
              Download notes
            </button>
            <button type="button" className="panel-action" onClick={() => downloadPdfAnnotations(projectKey, "pdf")}>
              Download PDF
            </button>
          </div>
        ) : null}
      </div>
      <div className={`notes-scroll${view === "mine" ? " has-composer" : ""}`} key={view}>
        {shown.length === 0 ? (
          view === "review"
            ? <PanelEmpty icon="review-notes" label="No saved findings yet" />
            : <PanelEmpty icon="notes" label="No notes yet" />
        ) : null}
        {pages.map((pageNumber) => (
          <div className="notes-page" key={pageNumber}>
            <h3 className="notes-page-head">Page {pageNumber}</h3>
            {shown.filter((annotation) => annotation.page === pageNumber).map(item)}
          </div>
        ))}
      </div>
      {view === "mine" ? (
        <div className="composer-tray">
        {error ? <div className="form-error notes-error">{error}</div> : null}
        <div className="notes-composer">
          <textarea
            value={draft}
            rows={1}
            placeholder="Add a note"
            disabled={adding}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void add();
              }
            }}
          />
          <button type="button" className="composer-send" disabled={!draft.trim() || adding} onClick={() => void add()}>
            Add
          </button>
        </div>
        </div>
      ) : error ? <div className="form-error notes-error">{error}</div> : null}
    </section>
  );
}
