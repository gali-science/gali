import { useState } from "react";
import { deleteProject, type ProjectDto } from "../../api";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message || String(cause) : String(cause);
}

export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: ProjectDto;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [confirmTitle, setConfirmTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canDelete =
    confirmTitle.trim().replace(/\s+/g, " ").toLowerCase()
    === project.title.trim().replace(/\s+/g, " ").toLowerCase();

  async function submit() {
    if (!canDelete || busy) return;
    setBusy(true);
    setError("");
    try {
      await deleteProject(project.key, project.title);
      onDeleted();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="import-modal"
        role="dialog"
        aria-label="Delete"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <div className="eyebrow">Delete</div>
            <h2>{project.title}</h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </header>
        <p className="empty-copy">
          This permanently deletes all its files, your notes, and Gali&rsquo;s work.
          A running review is stopped.
        </p>
        <label>
          Type the title to confirm
          <input
            value={confirmTitle}
            onChange={(event) => setConfirmTitle(event.target.value)}
            placeholder={project.title}
            autoFocus
          />
        </label>
        {error && (
          <div className="delete-project-error" role="alert">
            <strong>Couldn’t delete</strong>
            <p>{error}</p>
          </div>
        )}
        <footer>
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={!canDelete || busy}
            onClick={() => void submit()}
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
        </footer>
      </section>
    </div>
  );
}
