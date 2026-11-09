import "katex/dist/katex.min.css";
import { Component, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

class MarkdownGuard extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function Markdown({
  children,
  compact = false,
  notes = false,
  math = true,
}: {
  children: string;
  compact?: boolean;
  notes?: boolean;
  math?: boolean;
}) {
  const [mathReady, setMathReady] = useState(!notes);

  useEffect(() => {
    if (!notes || !math) return;
    setMathReady(false);
    const frame = window.requestAnimationFrame(() => setMathReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [notes, math, children]);

  const enableMath = math && mathReady;

  return (
    <div className={`safe-markdown${compact ? " safe-markdown-compact" : ""}${notes ? " notes-md" : ""}`}>
      {notes && !children.trim() ? (
        <p className="notes-md-empty">This file is empty.</p>
      ) : (
        <MarkdownGuard fallback={<pre className="notes-md-fallback">{children}</pre>}>
          <ReactMarkdown
            remarkPlugins={enableMath ? [remarkGfm, remarkMath] : [remarkGfm]}
            rehypePlugins={enableMath ? [[rehypeKatex, { throwOnError: false, strict: "ignore" }]] : []}
            components={{
              a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
              img: ({ src, alt }) => {
                const href = typeof src === "string" ? src : "";
                if (!href) return null;
                return (
                  <a href={href} target="_blank" rel="noreferrer">
                    {alt?.trim() || href}
                  </a>
                );
              },
            }}
          >
            {children}
          </ReactMarkdown>
        </MarkdownGuard>
      )}
    </div>
  );
}
