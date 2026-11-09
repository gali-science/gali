import type { ReactNode } from "react";

const ICONS: Record<"review" | "notes" | "review-notes" | "chat", ReactNode> = {
  review: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h7l5 5v13H6z" /><path d="M13 3v5h5" /><path d="m9 14 2 2 3.5-4" /></svg>,
  notes: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 4h14v12l-5 4H5z" /><path d="M14 20v-4h5" /><path d="M9 9h6M9 12.5h4" /></svg>,
  "review-notes": <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M7 4h10v17l-5-4-5 4z" /></svg>,
  chat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4.5h16v11H9l-5 4z" /></svg>,
};

export function PanelEmpty({ icon, label }: { icon: keyof typeof ICONS; label: string }) {
  return (
    <div className="panel-empty">
      <span className="panel-empty-icon" aria-hidden="true">
        {ICONS[icon]}
      </span>
      <p className="panel-empty-label">{label}</p>
    </div>
  );
}
