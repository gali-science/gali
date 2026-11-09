import { useState, type ReactNode } from "react";

function LegalLink({
  label,
  title,
  className = "demo-terms-link",
  children,
}: {
  label: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            event.stopPropagation();
            setOpen(false);
          }}
        >
          <section
            className="import-modal"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{title}</h2>
            </header>
            <p className="demo-terms-text">{children}</p>
            <footer>
              <button type="button" className="primary" onClick={() => setOpen(false)}>
                Close
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

export function DemoTermsLink({ label, className }: { label: string; className?: string }) {
  return (
    <LegalLink label={label} title="Gali Demo Terms" className={className}>
      Gali on the web is a research demo, provided “as is” without warranties of any kind.
      Outputs may be inaccurate, and you are responsible for how you use them. Do not upload
      sensitive, confidential, or personal data. You are responsible for the content you
      add.
    </LegalLink>
  );
}

export function UploadNotice() {
  return (
    <div className="upload-notice">
      <div>Research preview. Do not upload confidential information.</div>{" "}
      <div>
        By uploading, you agree to the <DemoTermsLink label="Demo Terms" /> and{" "}
        <PrivacyLink label="Privacy Notice" />.
      </div>
    </div>
  );
}

export function OutputNotice() {
  return <p className="output-notice">Gali can make mistakes. Verify before relying on it.</p>;
}

export function PrivacyLink({ label, className }: { label: string; className?: string }) {
  return (
    <LegalLink label={label} title="Privacy Notice" className={className}>
      Gali is a research preview. It runs on Vercel (
      <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noreferrer" aria-label="Vercel privacy policy">
        privacy policy
      </a>
      ) and uses models from Together AI and OpenAI. Your questions, PDFs, and code are processed
      by models served through Together AI (
      <a href="https://www.together.ai/privacy" target="_blank" rel="noreferrer" aria-label="Together AI privacy policy">
        privacy policy
      </a>
      ). Your voice and transcripts are processed by OpenAI (
      <a href="https://openai.com/policies/row-privacy-policy/" target="_blank" rel="noreferrer" aria-label="OpenAI privacy policy">
        privacy policy
      </a>
      ).
    </LegalLink>
  );
}
