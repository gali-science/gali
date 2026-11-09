import { useCallback, useEffect, useRef, useState } from "react";
import { readProjectFile, readProjectMedia } from "../../api";
import { Markdown } from "../../Markdown";
import { CodePreview } from "./CodePreview";
import { fileKind } from "./file-kind";
import { PdfPreview } from "./PdfPreview";

type MediaKind = "image" | "audio" | "video" | "pdf";

// Binary media never reads as text, so it goes straight to the media route;
// SVG does read as text and renders from it.
function viewerMediaKind(filePath: string): MediaKind | null {
  const kind = fileKind(filePath);
  if (kind === "image") return filePath.toLowerCase().endsWith(".svg") ? null : "image";
  return kind === "audio" || kind === "video" || kind === "pdf" ? kind : null;
}

function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown)$/i.test(filePath);
}

function isHtmlPath(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

export function SourceFileViewer({
  projectKey,
  path,
  revision = 0,
  lines,
  onViewState,
}: {
  projectKey: string;
  path: string;
  /** Bumps when the file may have changed on disk. */
  revision?: number;
  lines?: [number, number] | null;
  onViewState?: (state: "loading" | "ready" | "av") => void;
}) {
  const [content, setContent] = useState("");
  const [meta, setMeta] = useState<
    { kind: string; binary: boolean; bytes: number; oversized?: boolean } | null
  >(null);
  const [media, setMedia] = useState<
    { kind: MediaKind; url: string; data?: ArrayBuffer } | null
  >(null);
  const [truncated, setTruncated] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [codeState, setCodeState] = useState<"loading" | "ready">("loading");
  // Discards stale in-flight Load more appends after the viewed file changes.
  const loadEpochRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    loadEpochRef.current += 1;
    setError("");
    setCodeState("loading");
    setContent("");
    setMeta(null);
    setMedia(null);
    setTruncated(false);
    setNextOffset(null);
    setLoadingMore(false);
    const showMedia = async (mediaKind: MediaKind) => {
      try {
        const document = await readProjectMedia(projectKey, path);
        const bytes = new Uint8Array(document.data.byteLength);
        bytes.set(document.data);
        objectUrl = URL.createObjectURL(new Blob([bytes.buffer], { type: document.mime }));
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        // PDFs render from bytes, not the URL: the pdfium worker cannot
        // resolve a blob: URL minted here.
        setMedia(
          mediaKind === "pdf"
            ? { kind: mediaKind, url: objectUrl, data: bytes.buffer }
            : { kind: mediaKind, url: objectUrl },
        );
      } catch (mediaCause) {
        if (cancelled) return;
        const oversized = /exceeds display limit/i.test(String(mediaCause));
        setMeta({ kind: mediaKind, binary: true, bytes: 0, ...(oversized ? { oversized: true } : {}) });
      }
    };
    const directMedia = viewerMediaKind(path);
    if (directMedia) {
      void showMedia(directMedia);
    } else if (fileKind(path) === "binary") {
      setMeta({ kind: "binary", binary: true, bytes: 0 });
    } else {
      void readProjectFile(projectKey, path)
        .then((document) => {
          if (cancelled) return;
          // SVG comes back as text (binary: false); render it as an image.
          if (document.file.kind === "image" && !document.file.binary) {
            if (document.truncated) {
              setMeta({ kind: "image", binary: true, bytes: document.file.bytes, oversized: true });
              return;
            }
            objectUrl = URL.createObjectURL(
              new Blob([document.content], { type: "image/svg+xml" }),
            );
            setMedia({ kind: "image", url: objectUrl });
            return;
          }
          setMeta({
            kind: document.file.kind,
            binary: document.file.binary,
            bytes: document.file.bytes,
          });
          setTruncated(document.truncated === true);
          setNextOffset(document.nextOffset ?? null);
          setContent(document.content);
        })
        .catch((cause) => {
          if (cancelled) return;
          if (/binary/i.test(String(cause))) {
            setMeta({ kind: "binary", binary: true, bytes: 0 });
            return;
          }
          setError(String(cause));
        });
    }
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, projectKey, revision]);

  const [imageLoaded, setImageLoaded] = useState(false);
  useEffect(() => {
    setImageLoaded(false);
  }, [path, projectKey, revision]);

  useEffect(() => {
    if (!onViewState) return;
    if (media) {
      if (media.kind === "audio" || media.kind === "video") onViewState("av");
      else if (media.kind === "image") onViewState(imageLoaded ? "ready" : "loading");
      else onViewState("ready");
      return;
    }
    if (error || meta?.binary) onViewState("ready");
    else if (meta === null && content === "") onViewState("loading");
    else if (isMarkdownPath(path) || isHtmlPath(path)) onViewState("ready");
    else onViewState(codeState);
  }, [onViewState, media, imageLoaded, error, meta, content, path, codeState]);

  const loadMore = useCallback(() => {
    if (nextOffset === null || loadingMore) return;
    const epoch = loadEpochRef.current;
    setLoadingMore(true);
    void readProjectFile(projectKey, path, nextOffset)
      .then((document) => {
        if (loadEpochRef.current !== epoch) return;
        setContent((prev) => prev + document.content);
        setTruncated(document.truncated === true);
        setNextOffset(document.nextOffset ?? null);
      })
      .catch((cause) => {
        if (loadEpochRef.current !== epoch) return;
        setError(String(cause));
      })
      .finally(() => {
        if (loadEpochRef.current === epoch) setLoadingMore(false);
      });
  }, [nextOffset, loadingMore, projectKey, path]);

  useEffect(() => {
    if (!truncated || nextOffset === null || loadingMore) return;
    if (!isMarkdownPath(path) && !isHtmlPath(path)) return;
    loadMore();
  }, [truncated, nextOffset, loadingMore, path, loadMore]);

  const truncatedNotice = truncated
    ? (
        <div className="source-file-notice is-strip">
          <span className="source-file-notice-msg">
            <span className="source-file-notice-dot" aria-hidden="true" />
            Showing the first part of this file
          </span>
          <button
            type="button"
            className="source-file-notice-more"
            onClick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )
    : null;

  const mediaPreview = media
    ? media.kind === "image"
      ? (
        <img
          className="source-file-media"
          src={media.url}
          alt={path}
          onLoad={() => setImageLoaded(true)}
        />
      )
      : media.kind === "audio"
        ? <audio className="source-file-media" src={media.url} controls />
        : media.kind === "video"
          ? <video className="source-file-media" src={media.url} controls />
          : media.data
            ? <PdfPreview data={media.data} identity={path} />
            : null
    : null;

  return (
    <div className="source-file-embedded">
      {error && <div className="form-error">{error}</div>}
      {mediaPreview}
      {!media && meta?.binary && (
        <div className="source-file-notice is-empty">
          <p className="source-file-notice-title">
            {meta.oversized ? "This file is too large to preview." : "No preview for this format."}
          </p>
          <p className="source-file-notice-sub">Gali can still read it.</p>
        </div>
      )}
      {!media && !meta?.binary && (content !== "" || meta !== null) && (
        isMarkdownPath(path)
          ? (
            <>
              {truncatedNotice}
              <div className="source-file-markdown"><Markdown notes>{content}</Markdown></div>
            </>
          )
          : isHtmlPath(path)
            ? (
              <>
                {truncatedNotice}
                <iframe className="source-file-html" title={path} sandbox="" srcDoc={content} />
              </>
            )
            : (
              <CodePreview
                path={path}
                code={content}
                notice={truncatedNotice ?? undefined}
                targetLines={lines}
                onViewState={setCodeState}
              />
            )
      )}
      {!media && meta === null && content === "" && !error && (
        <p className="code-preview-loading">Loading…</p>
      )}
    </div>
  );
}
