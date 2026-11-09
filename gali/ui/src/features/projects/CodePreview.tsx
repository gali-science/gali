import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { languageFromPath } from "./language-from-path";

function fileName(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function pathSegments(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function CodePreview({
  path,
  code,
  notice,
  targetLines,
  onViewState,
}: {
  path: string;
  code: string;
  notice?: ReactNode;
  /** First and last line to scroll to and mark. */
  targetLines?: [number, number] | null;
  onViewState?: (state: "loading" | "ready") => void;
}) {
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [html, setHtml] = useState("");
  // React 19 compares this prop by identity; a fresh object re-sets innerHTML and drops the is-target marks.
  const markup = useMemo(() => ({ __html: html }), [html]);
  const [error, setError] = useState("");
  const language = languageFromPath(path);
  const name = fileName(path);
  const crumbs = pathSegments(path);
  const lines = code === "" ? 0 : code.split(/\r\n|\r|\n/).length;

  useEffect(() => {
    let cancelled = false;
    setHtml("");
    setError("");
    void import("shiki")
      .then(({ codeToHtml }) =>
        codeToHtml(code, {
          lang: language,
          theme: "houston",
          transformers: [
            {
              line(node: { properties: Record<string, unknown> }, line: number) {
                node.properties["data-line"] = String(line);
              },
            },
          ],
        }),
      )
      .then((next) => {
        if (!cancelled) setHtml(next);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  // Ready means painted code, not fetched text: a capture during the
  // "Highlighting…" placeholder sends the model an image without the rows.
  const painted = error !== "" || html !== "";
  useEffect(() => {
    onViewState?.(painted ? "ready" : "loading");
  }, [onViewState, painted]);

  useEffect(() => {
    const host = previewRef.current;
    if (!host || !html) return;
    const rows = Array.from(host.querySelectorAll<HTMLElement>("[data-line]"));    for (const row of rows) row.classList.remove("is-target");
    if (!targetLines) return;
    const [first, last] = targetLines;
    const marked = rows.filter((row) => {
      const line = Number(row.dataset.line);
      return line >= first && line <= last;
    });
    for (const row of marked) row.classList.add("is-target");
    marked[0]?.scrollIntoView({ block: "center" });
  }, [html, targetLines]);

  return (
    <div className="code-window" data-language={language}>
      <header className="code-window-head" title={path}>
        <span className="code-window-name">{name}</span>
        <span className="code-window-path">
          {crumbs.slice(0, -1).map((segment, index) => (
            <span key={`${segment}:${index}`}>
              {index > 0 && <span className="code-crumb-sep">/</span>}
              {segment}
            </span>
          ))}
        </span>
        <span className="code-window-meta">
          {language}
          {lines > 0 ? ` · ${lines}` : ""}
        </span>
      </header>
      {notice}
      {error && <pre className="source-file-data code-preview-fallback">{code}</pre>}
      {!error && !html && <p className="code-preview-loading">Highlighting…</p>}
      {!error && html && (
        <div
          ref={previewRef}
          className="code-preview"
          dangerouslySetInnerHTML={markup}
        />
      )}
    </div>
  );
}
