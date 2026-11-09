import { useState } from "react";

export function ModelConsentScreen({
  busy,
  error,
  onAccept,
  onSignOut,
}: {
  busy: boolean;
  error: string | null;
  onAccept: () => void;
  onSignOut: () => void;
}) {
  const [voiceAccepted, setVoiceAccepted] = useState(false);
  const [experimentsAccepted, setExperimentsAccepted] = useState(false);
  const ready = voiceAccepted && experimentsAccepted;

  return (
    <section className="roster-pane is-empty boot-pane login-pane">
      <div className="book home-book is-empty">
        <div className="home-empty consent-screen">
          <header className="home-hero">
            <div className="eyebrow">Research preview</div>
            <h1 className="home-title">Before you enter Gali</h1>
            <p className="home-lede">
              Confirm how Gali uses model providers for voice and review.
            </p>
          </header>

          <label className="consent-option">
            <input
              type="checkbox"
              checked={voiceAccepted}
              onChange={(event) => setVoiceAccepted(event.target.checked)}
            />
            <span>
              I understand that Gali sends my voice audio and transcript to OpenAI
              to provide voice features.
            </span>
          </label>

          <label className="consent-option">
            <input
              type="checkbox"
              checked={experimentsAccepted}
              onChange={(event) => setExperimentsAccepted(event.target.checked)}
            />
            <span>
              I understand that Gali sends my questions, the PDF, and its code
              to models provided through Together AI.
            </span>
          </label>

          {error ? <div className="form-error">{error}</div> : null}

          <div className="mcp-actions">
            <button type="button" className="secondary" disabled={busy} onClick={onSignOut}>
              Sign out
            </button>
            <button
              type="button"
              className="primary consent-continue"
              disabled={!ready || busy}
              onClick={onAccept}
            >
              {busy ? "Saving…" : "Continue"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
