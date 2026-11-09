import { useState, type DragEvent } from "react";
import type { ProjectDto } from "../../api";
import { UploadNotice } from "../boot/DemoTerms";
import { checkCodeZip, checkPaperFile, uploadPaperProject, type PaperUploadPhase } from "./import-upload";

function titleFromPdf(name: string): string {
  return name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled";
}

function phaseLabel(phase: PaperUploadPhase | null): string {
  if (!phase || phase.step === "packing") return "Preparing…";
  if (phase.step === "uploading") return `Uploading ${Math.min(99, Math.round((phase.sent / phase.total) * 100))}%`;
  return "Unpacking…";
}

function split(files: readonly File[]): { paper: File; code: File | null } {
  const lower = (file: File) => file.name.toLowerCase();
  const papers = files.filter((file) => lower(file).endsWith(".pdf") || file.type === "application/pdf");
  const zips = files.filter((file) => lower(file).endsWith(".zip"));
  if (papers.length !== 1) {
    throw new Error(papers.length === 0 ? "Drop a PDF: a paper, chapter, or notes." : "Drop one PDF at a time.");
  }
  if (zips.length > 1) throw new Error("Drop at most one code zip.");
  if (papers.length + zips.length !== files.length) throw new Error("Only a PDF and an optional code .zip.");
  const paper = papers[0]!;
  checkPaperFile(paper);
  const code = zips[0] ?? null;
  if (code) checkCodeZip(code);
  return { paper, code };
}

/** The desktop home: drop a PDF (and its code) to start a project. */
export function NewProjectDrop({ onCreated, onChooseFiles }: { onCreated: (project: ProjectDto) => void; onChooseFiles: () => void }) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<PaperUploadPhase | null>(null);
  const [error, setError] = useState("");

  async function start(files: readonly File[]) {
    if (busy || files.length === 0) return;
    setError("");
    let picked: { paper: File; code: File | null };
    try {
      picked = split(files);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setBusy(true);
    try {
      onCreated(await uploadPaperProject({
        title: titleFromPdf(picked.paper.name),
        paper: picked.paper,
        ...(picked.code ? { code: picked.code } : {}),
        onPhase: setPhase,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    void start([...event.dataTransfer.files]);
  }

  return (
    <section
      className="drop-page"
      aria-label="New project"
      onDragOver={(event) => {
        event.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="drop-zone">
        <span className="drop-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15V5M8 9l4-4 4 4" />
            <path d="M5 19h14" />
          </svg>
        </span>
        <h1 className="drop-title">{busy ? phaseLabel(phase) : "Drop a PDF and its code"}</h1>
        <p className="drop-sub">Paper, chapter, or notes. Code is optional.</p>
        {error ? <p className="drop-error" role="alert">{error}</p> : null}
        <button type="button" className="drop-pick" disabled={busy} onClick={onChooseFiles}>
          Choose files
        </button>
      </div>
      <UploadNotice />
      {dragging ? <div className="drop-overlay" aria-hidden="true">Drop a PDF and its code</div> : null}
    </section>
  );
}
