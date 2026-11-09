import { useEffect } from "react";

export function TrialKeyPrompt({
  open,
  exhausted,
  remainingUsd,
  budgetUsd,
  onClose,
}: {
  open: boolean;
  exhausted: boolean;
  remainingUsd: number;
  budgetUsd: number;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div className="trial-key-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="trial-key-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trial-key-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="trial-key-title">
          {exhausted
            ? "Your trial is spent"
            : `$${remainingUsd.toFixed(2)} left in your $${budgetUsd.toFixed(2)} trial`}
        </h2>
        <p>
          {exhausted
            ? "Your work stays here. Contact us to keep reviewing."
            : "Your work stays here when the trial ends."}
        </p>
        <div className="trial-key-actions">
          <button type="button" className="primary" onClick={onClose}>Got it</button>
        </div>
      </section>
    </div>
  );
}
