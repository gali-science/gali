import { useEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import guideHtml from "./guide.html?raw";
import "./guide.css";

export function ReviewGuide({ onClose }: { onClose: () => void }) {
  const [reading, setReading] = useState(false);
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (card.current) card.current.scrollTop = 0;
  }, [reading]);

  const onClick = (event: MouseEvent) => {
    const action = (event.target as HTMLElement).closest<HTMLElement>("[data-guide]")?.dataset.guide;
    if (action === "read") setReading(true);
    if (action === "back") setReading(false);
    if (action === "close") onClose();
  };

  return createPortal(
    <div className="rg-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <article
        ref={card}
        className={`rg${reading ? " is-reading" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-title"
        onClick={onClick}
      >
        <button type="button" className="close" aria-label="Close" data-guide="close">×</button>
        <div dangerouslySetInnerHTML={{ __html: guideHtml }} />
      </article>
    </div>,
    document.body,
  );
}
