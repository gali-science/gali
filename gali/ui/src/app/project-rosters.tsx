import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectDto } from "../api";
import { fmtWhen } from "../lib/fmt-when";
import { IconAccount, IconPlus } from "./icons";

type CommonProps = {
  projects: ProjectDto[];
  onOpen: (key: string) => void;
};

const EARLIER_SHELF = 8;

function paperName(project: ProjectDto): string {
  if (project.paperPath === null) return "No PDF";
  return project.paperPath.split("/").at(-1) ?? project.paperPath;
}

function useSorted(projects: ProjectDto[]): ProjectDto[] {
  return useMemo(
    () => [...projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [projects],
  );
}

function AccountButton({ className, onOpenAccount }: { className: string; onOpenAccount: () => void }) {
  return (
    <button type="button" className={className} onClick={onOpenAccount} title="Account" aria-label="Account">
      <IconAccount />
    </button>
  );
}

export function DesktopProjectsRoster({
  projects,
  onOpen,
  onNewPaper,
  onOpenAccount,
}: CommonProps & { onNewPaper: () => void; onOpenAccount: () => void }) {
  const sorted = useSorted(projects);
  const [now, ...earlier] = sorted;
  const [showAll, setShowAll] = useState(false);
  const shelf = showAll ? earlier : earlier.slice(0, EARLIER_SHELF);

  return (
    <section className={`roster-pane${now ? "" : " is-empty"}`}>
      {now ? null : <AccountButton className="home-account is-corner" onOpenAccount={onOpenAccount} />}
      <div className={`book home-book${now ? "" : " is-empty"}`}>
        {!now ? (
          <div className="home-empty home-empty-centered">
            <i className="fa-solid fa-circle-half-stroke home-empty-mark" aria-hidden="true" />
            <header className="home-hero home-empty-hero">
              <h1 className="home-title home-empty-title">Gali</h1>
            </header>
            <p className="home-empty-lede">Add a PDF and its code to start a review.</p>
            <button type="button" className="primary home-empty-new" onClick={onNewPaper}>
              <IconPlus />
              Add to library
            </button>
          </div>
        ) : (
          <>
            <header className="home-hero has-actions">
              <h1 className="home-title">Library</h1>
              <div className="home-actions">
                <button type="button" className="primary home-new" onClick={onNewPaper} title="Add to library" aria-label="Add to library">
                  <IconPlus />
                </button>
                <AccountButton className="home-account" onOpenAccount={onOpenAccount} />
              </div>
            </header>
            <button type="button" className="now" onClick={() => onOpen(now.key)}>
              <div className="body">
                <div className="title">{now.title}</div>
                <p className="claim faint">{paperName(now)}</p>
                <div className="now-actions">
                  <span className="go">Open</span>
                </div>
              </div>
            </button>
            {earlier.length > 0 && (
              <>
                <div className="eyebrow roster-earlier">Earlier</div>
                <ul className="roster-shelf">
                  {shelf.map((project) => (
                    <li key={project.key}>
                      <button type="button" className="shelf-card" onClick={() => onOpen(project.key)}>
                        <div className="shelf-meta">
                          <div className="shelf-top">
                            <span className="name">{project.title}</span>
                            <span className="when">{fmtWhen(project.updatedAt)}</span>
                          </div>
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
                {earlier.length > EARLIER_SHELF && (
                  <button type="button" className="roster-more" onClick={() => setShowAll((value) => !value)}>
                    {showAll ? "Show fewer" : `Show all ${sorted.length}`}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function MobileProjectsRoster({
  projects,
  onOpen,
  onNewPaper,
  onOpenAccount,
}: CommonProps & {
  onNewPaper: () => void;
  onOpenAccount: () => void;
}) {
  const sorted = useSorted(projects);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = (
    <button
      type="button"
      className="mobile-home-menu"
      aria-expanded={menuOpen}
      aria-haspopup="menu"
      aria-label="More actions"
      title="More actions"
      onClick={() => setMenuOpen(true)}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="5.5" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="12" cy="18.5" r="1.4" />
      </svg>
    </button>
  );

  return (
    <section className={`roster-pane${sorted.length === 0 ? " is-empty" : ""}`}>
      <div className={`book home-book${sorted.length === 0 ? " is-empty" : ""}`}>
        {sorted.length === 0 ? (
          <>
            {menuButton}
            <div className="home-empty mobile-home-empty">
              <i className="fa-solid fa-circle-half-stroke home-empty-mark" aria-hidden="true" />
              <h1 className="mobile-home-empty-title">Gali</h1>
              <p className="home-empty-hint">Add a PDF and its code to start a review.</p>
              <button type="button" className="mobile-home-empty-cta" onClick={onNewPaper}>Add to library</button>
            </div>
          </>
        ) : (
          <div className="mobile-home">
            <header className="mobile-home-brand">{menuButton}</header>
            <ul className="mobile-home-rows">
              {sorted.map((project) => (
                <li key={project.key}>
                  <button type="button" className="mobile-home-row" onClick={() => onOpen(project.key)}>
                    <span className="mobile-home-row-title">{project.title}</span>
                    <span className="mobile-home-row-when">{fmtWhen(project.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="mobile-home-actions">
              <button type="button" className="mobile-home-action" onClick={onNewPaper}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                Add to library
              </button>
            </div>
          </div>
        )}
        {menuOpen ? createPortal(
          <div className="phone-actions-layer">
            <button type="button" className="phone-actions-backdrop" aria-label="Dismiss" onClick={() => setMenuOpen(false)} />
            <div className="phone-actions-sheet" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onOpenAccount(); }}>Account</button>
              <button type="button" className="phone-actions-cancel" onClick={() => setMenuOpen(false)}>Cancel</button>
            </div>
          </div>,
          document.body,
        ) : null}
      </div>
    </section>
  );
}
