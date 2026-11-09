import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { githubCloneUrl } from "../../../../shared/domain/contracts";
import { shortTitle, titleFromPdfName } from "../../../../shared/domain/project-title";
import type { ProjectDto } from "../../api";
import { IconChevron, IconCode, IconDown, IconPage } from "../../app/icons";
import { UploadNotice } from "../boot/DemoTerms";
import {
  checkCodeZip,
  checkPaperFile,
  uploadPaperProject,
  type PaperUploadPhase,
} from "./import-upload";

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function phaseLabel(phase: PaperUploadPhase | null, cloning: boolean): string {
  if (!phase || phase.step === "packing") return "Preparing…";
  if (phase.step === "uploading") {
    return `Uploading ${Math.min(99, Math.round((phase.sent / phase.total) * 100))}%`;
  }
  return cloning ? "Cloning…" : "Unpacking…";
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

export function NewPaperDialog({
  initialTitle = "",
  onClose,
  onCreated,
}: {
  initialTitle?: string;
  onClose: () => void;
  onCreated: (project: ProjectDto) => void;
}) {
  const paperRef = useRef<HTMLInputElement | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const [paper, setPaper] = useState<File | null>(null);
  const [code, setCode] = useState<File | null>(null);
  const [link, setLink] = useState("");
  const [codeOpen, setCodeOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [phase, setPhase] = useState<PaperUploadPhase | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function accept(file: File, check: (file: File) => void, set: (file: File | null) => void): boolean {
    try {
      check(file);
      set(file);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }

  function acceptCode(file: File) {
    if (!accept(file, checkCodeZip, setCode)) return;
    setLink("");
  }

  function removeCode() {
    setCode(null);
    setLink("");
    setCodeOpen(false);
  }

  function pick(event: ChangeEvent<HTMLInputElement>, take: (file: File) => void) {
    setError("");
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) take(file);
  }

  function drop(event: DragEvent<HTMLElement>) {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    setError("");
    for (const file of Array.from(event.dataTransfer.files)) {
      const name = file.name.toLowerCase();
      if (name.endsWith(".pdf")) accept(file, checkPaperFile, setPaper);
      else if (name.endsWith(".zip")) acceptCode(file);
      else setError("drop a .pdf or a .zip of the code");
    }
  }

  const codeUrl = link.trim();
  const projectTitle = initialTitle.trim() || (paper ? shortTitle(titleFromPdfName(paper.name)) : "");
  const canSubmit = Boolean(projectTitle) && Boolean(paper);

  async function submit() {
    if (!canSubmit || !paper) return;
    if (codeUrl && !githubCloneUrl(codeUrl)) {
      setError("the code link must look like https://github.com/owner/repo");
      return;
    }
    setBusy(true);
    setError("");
    try {
      onCreated(await uploadPaperProject({
        title: projectTitle,
        paper,
        ...(code ? { code } : {}),
        ...(codeUrl ? { codeUrl } : {}),
        onPhase: setPhase,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  function codeSource() {
    if (code) {
      return (
        <div className="np-row">
          <IconCode />
          <span className="np-value" aria-label="Code zip">{code.name}</span>
          <span className="np-meta">{formatBytes(code.size)}</span>
          <button type="button" className="np-remove" disabled={busy} onClick={removeCode} aria-label="Remove code">×</button>
        </div>
      );
    }
    return (
      <div className="np-row">
        <IconCode />
        <input
          className="np-link"
          value={link}
          autoFocus
          disabled={busy}
          onChange={(event) => {
            setError("");
            setLink(event.target.value);
          }}
          placeholder="GitHub link"
          aria-label="GitHub link"
        />
        {link.trim() ? (
          <button type="button" className="np-remove" disabled={busy} onClick={removeCode} aria-label="Remove code">×</button>
        ) : (
          <button type="button" className="np-or" disabled={busy} onClick={() => codeRef.current?.click()}>
            or a .zip
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <section
        className="import-modal new-paper"
        role="dialog"
        aria-label="Add to library"
        onMouseDown={(event) => event.stopPropagation()}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          if (!busy) setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={drop}
      >
        <h2>Add to library</h2>

        <div className="np-section">
          <div className="np-group">
            {paper ? (
              <div className="np-row">
                <IconPage />
                <span className="np-value" aria-label="PDF">{paper.name}</span>
                <span className="np-meta">{formatBytes(paper.size)}</span>
                <button type="button" className="np-remove" disabled={busy} onClick={() => setPaper(null)} aria-label="Remove PDF">×</button>
              </div>
            ) : (
              <button type="button" className="np-row" disabled={busy} onClick={() => paperRef.current?.click()} aria-label="Choose PDF">
                <IconPage />
                <span className="np-label">PDF</span>
                <span className="np-sub">required</span>
                <span className="np-action">Choose<IconChevron /></span>
              </button>
            )}
            {code || link || codeOpen ? codeSource() : (
              <button type="button" className="np-row" disabled={busy} onClick={() => setCodeOpen(true)} aria-label="Add code">
                <IconCode />
                <span className="np-label">Code</span>
                <span className="np-sub">optional</span>
                <span className="np-action">GitHub link or .zip<IconChevron /></span>
              </button>
            )}
          </div>
        </div>

        <input
          ref={paperRef}
          type="file"
          accept=".pdf,application/pdf"
          style={{ display: "none" }}
          onChange={(event) => pick(event, (file) => accept(file, checkPaperFile, setPaper))}
        />
        <input
          ref={codeRef}
          type="file"
          accept=".zip,application/zip"
          style={{ display: "none" }}
          onChange={(event) => pick(event, acceptCode)}
        />

        {error && <div className="form-error">{error}</div>}
        <UploadNotice />
        <footer>
          <button type="button" className="secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={busy || !canSubmit}
            onClick={() => void submit()}
          >
            {busy ? phaseLabel(phase, Boolean(codeUrl)) : "Add"}
          </button>
        </footer>

        {dragging && (
          <div className="np-drop" aria-hidden="true">
            <div><IconDown />Drop to add<span>A PDF, or its code as a .zip</span></div>
          </div>
        )}
      </section>
    </div>
  );
}
