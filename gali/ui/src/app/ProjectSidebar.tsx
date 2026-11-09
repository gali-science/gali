import { useMemo, useState } from "react";
import type { ProjectDto } from "../api";
import { ReviewGuide } from "../features/guide/ReviewGuide";

export function ProjectSidebar({
  projects,
  selectedProjectKey,
  accountOpen,
  onNew,
  onOpen,
  onOpenAccount,
}: {
  projects: readonly ProjectDto[];
  selectedProjectKey: string | null;
  accountOpen: boolean;
  onNew: () => void;
  onOpen: (projectKey: string) => void;
  onOpenAccount: () => void;
}) {
  const sorted = useMemo(
    () => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects],
  );
  const newOn = selectedProjectKey === null && !accountOpen;
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <nav className="sb" aria-label="Projects">
      <div className="sb-mark">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 2.5a9.5 9.5 0 0 1 0 19z" fill="currentColor" />
        </svg>
        <span className="sb-label">Gali</span>
      </div>
      <button
        type="button"
        className={`sb-btn is-new${newOn ? " is-on" : ""}`}
        onClick={onNew}
        title="New"
        aria-current={newOn ? "page" : undefined}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span className="sb-label">New</span>
      </button>
      <ul className="sb-list">
        {sorted.map((project) => {
          const on = project.key === selectedProjectKey;
          return (
            <li key={project.key}>
              <button
                type="button"
                className={`sb-row${on ? " is-on" : ""}`}
                onClick={() => onOpen(project.key)}
                title={project.title}
                aria-current={on ? "page" : undefined}
              >
                <span className="sb-dot" aria-hidden="true" />
                <span className="sb-name sb-label">{project.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <button type="button" className="sb-btn" onClick={() => setGuideOpen(true)} title="Reviewing with AI">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 6.5C10.3 5.2 7.8 4.8 4.5 5v13c3.3-.2 5.8.2 7.5 1.5 1.7-1.3 4.2-1.7 7.5-1.5V5c-3.3-.2-5.8.2-7.5 1.5Z" />
          <path d="M12 6.5v13" />
        </svg>
        <span className="sb-label">Reviewing with AI</span>
      </button>
      <button
        type="button"
        className={`sb-btn sb-account${accountOpen ? " is-on" : ""}`}
        onClick={onOpenAccount}
        title="Account"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="9" r="3.2" />
          <path d="M5.8 19a6.2 6.2 0 0 1 12.4 0" />
        </svg>
        <span className="sb-label">Account</span>
      </button>
      {guideOpen ? <ReviewGuide onClose={() => setGuideOpen(false)} /> : null}
    </nav>
  );
}
