import { useCallback, useEffect, useState } from "react";
import { getAccount } from "../../account";
import { useGaliAuth } from "../../auth";
import { useTranscriptDebug } from "../../transcript-debug";
import { DemoTermsLink, PrivacyLink } from "../boot/DemoTerms";

function SettingSwitch({ title, lede, on, onToggle }: {
  title: string;
  lede: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={title}
      className="env-switch-row"
      onClick={onToggle}
    >
      <span>
        <span className="env-section-title">{title}</span>
        <span className="env-section-lede">{lede}</span>
      </span>
      <span className={`side-toggle${on ? " is-on" : ""}`} aria-hidden="true"><span /></span>
    </button>
  );
}

export function AccountPage({ onGoHome }: { onGoHome?: () => void }) {
  const { signOut } = useGaliAuth();
  const [transcriptDebug, setTranscriptDebug] = useTranscriptDebug();
  const [displayName, setDisplayName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const account = await getAccount();
      if (!account) {
        setDisplayName("");
        setIdentityEmail("");
        return;
      }
      setDisplayName(account.displayName);
      setIdentityEmail(account.identityEmail);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <section className="roster-pane env-pane">
      <div className="book home-book env-book">
        <header className="home-hero">
          {onGoHome ? (
            <button type="button" className="secondary env-back" onClick={onGoHome}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m14 6-6 6 6 6" />
              </svg>
              Back to Home
            </button>
          ) : null}
          <h1 className="home-title">Account</h1>
          <p className="home-lede">
            {displayName || identityEmail
              ? [displayName, identityEmail].filter(Boolean).join(" · ")
              : "Your signed-in session."}
          </p>
        </header>

        {error ? <div className="form-error">{error}</div> : null}
        <section className="env-account">
          <SettingSwitch
            title="Show tool calls"
            lede="For troubleshooting: list every tool call with its raw data, and include it when you copy the transcript."
            on={transcriptDebug}
            onToggle={() => setTranscriptDebug(!transcriptDebug)}
          />
        </section>

        <section className="env-account">
          <h2 className="env-section-title">About</h2>
          <div className="env-actions">
            <a className="secondary" href="/about/">About Gali</a>
          </div>
        </section>

        <section className="env-account">
          <h2 className="env-section-title">Terms</h2>
          <div className="env-actions">
            <DemoTermsLink label="Demo Terms" className="secondary" />
            <PrivacyLink label="Privacy Notice" className="secondary" />
          </div>
        </section>

        <section className="env-account">
          <h2 className="env-section-title">Session</h2>
          <button
            type="button"
            className="secondary"
            onClick={() => void signOut({ redirectUrl: "/" })}
          >
            Sign out
          </button>
        </section>
      </div>
    </section>
  );
}
