import { useEffect, useMemo, useRef, useState } from "react";
import { OutputNotice } from "./features/boot/DemoTerms";
import { Markdown } from "./Markdown";
import { PanelEmpty } from "./PanelEmpty";
import {
  activityDetail,
  formatTranscript,
  transcriptItems,
  type ActivityIcon,
  type ActivityItem,
  type ActivityState,
} from "./transcript-activity";
import { useTranscriptDebug } from "./transcript-debug";
import type { VoiceLine } from "./useVoice";

export function formatDebugTranscript(lines: ReadonlyArray<VoiceLine>): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (line.kind === "message") {
      const text = line.text.trim();
      if (!text) continue;
      parts.push(`${line.role === "user" ? "User" : "Gali"}: ${text}`);
    } else if (line.kind === "tool") {
      parts.push(`[tool: ${line.name}]`);
      parts.push(JSON.stringify({ args: line.args, result: line.result }, null, 2));
    } else {
      parts.push(`[status] ${line.text}`);
    }
  }
  return parts.join("\n");
}

export function Chat({
  open,
  onClose,
  lines,
  sendText,
  phoneEmptyCopy = false,
  projects = [],
  embedded = false,
}: {
  open: boolean;
  onClose: () => void;
  /** Shown inside the paper screen's Chat tab, which carries the title and has no close. */
  embedded?: boolean;
  lines: VoiceLine[];
  /** Starts voice first when it is off; rejects when it cannot connect. */
  sendText: (text: string) => Promise<void>;
  phoneEmptyCopy?: boolean;
  projects?: ReadonlyArray<{ key: string; title: string }>;
}) {
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const [debug] = useTranscriptDebug();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const titles = useMemo(
    () => new Map(projects.map((project) => [project.key, project.title])),
    [projects],
  );
  const items = useMemo(() => transcriptItems(lines, titles), [lines, titles]);
  const empty = debug ? lines.length === 0 : items.length === 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [lines, open]);

  useEffect(() => {
    if (open) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".chat-drawer")) {
      active.blur();
    }
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    // A failed connect already shows on the voice island; keep the text to resend.
    void sendText(text).then(() => setInput(""), () => {});
  };

  const copyTranscript = () => {
    const text = debug ? formatDebugTranscript(lines) : formatTranscript(items);
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <aside className={`chat-drawer${open ? " open" : ""}${embedded ? " is-tab" : ""}`}>
      {embedded && empty ? null : <div className="vbar">
        <div className="live">
          {embedded ? null : <span className="chat-title">Chat</span>}
        </div>
        <div className="vbar-actions">
          <button
            type="button"
            className={`chat-copy${copied ? " is-copied" : ""}`}
            title="Copy chat"
            disabled={empty}
            onClick={copyTranscript}
          >
            <svg
              className="chat-copy-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {copied
                ? <path d="m5 12.5 4.5 4.5L19 7" />
                : <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>}
            </svg>
            <span>{copied ? "Copied" : embedded ? "Copy as text" : "Copy"}</span>
          </button>
          {embedded ? null : (
            <button
              type="button"
              className="chat-x"
              title="Close chat"
              onClick={(event) => {
                event.currentTarget.blur();
                onClose();
              }}
            >
              ✕
            </button>
          )}
        </div>
      </div>}

      <div ref={scrollRef} className={`thread${debug ? "" : " is-clean"}`}>
        {empty && embedded ? <PanelEmpty icon="chat" label="No messages yet" /> : null}
        {empty && !embedded && (
          <p className="chat-empty">
            {phoneEmptyCopy
              ? "Nothing yet. Press the mic to start — this shows the live voice conversation."
              : "Nothing yet. Press the orange button to talk with Gali — your conversation shows up here."}
          </p>
        )}
        {debug
          ? lines.map((line) => (
            <LineView key={line.id} line={line} phoneCompact={phoneEmptyCopy} />
          ))
          : items.map((item) =>
            item.kind === "activity" ? (
              <ActivityRow key={item.id} item={item} />
            ) : item.role === "user" ? (
              <div key={item.id} className="bubble u">{item.text}</div>
            ) : (
              <div key={item.id} className="bubble a">
                <Markdown compact>{item.text}</Markdown>
              </div>
            ),
          )}
      </div>
      <OutputNotice />

      {embedded ? null : <div className="composer-tray">
      <form onSubmit={submit} className="comp">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message…"
        />
        <button type="submit" disabled={!input.trim()}>
          ↩
        </button>
      </form>
      </div>}
    </aside>
  );
}

function LineView({ line, phoneCompact = false }: { line: VoiceLine; phoneCompact?: boolean }) {
  if (line.kind === "status") return <div className="st">{line.text}</div>;
  if (line.kind === "tool") {
    return (
      <details className={`tool${phoneCompact ? " tool-phone" : ""}`}>
        <summary>tool · {line.name}</summary>
        <pre>{JSON.stringify({ args: line.args, result: line.result }, null, 2)}</pre>
      </details>
    );
  }
  if (line.role === "user") return <div className="bubble u">{line.text}</div>;
  return (
    <div className="bubble a">
      <Markdown compact>{line.text}</Markdown>
    </div>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const detail = activityDetail(item);
  return (
    <div className={`activity${item.state ? ` is-${item.state}` : ""}`}>
      <ActivityGlyph icon={item.icon} state={item.state} />
      <span className="activity-text">
        <span className="activity-label">{item.label}</span>
        {detail ? <span className="activity-detail">{detail}</span> : null}
      </span>
    </div>
  );
}

const GLYPHS: Record<ActivityIcon, React.ReactNode> = {
  project: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  file: <><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5" /></>,
  page: <><path d="M3 5h6a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H3z" /><path d="M21 5h-6a3 3 0 0 0-3 3v12a2 2 0 0 1 2-2h7z" /></>,
  lookup: <><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>,
  reviewer: <><path d="M11 3a8 8 0 1 0 4.9 14.3L21 22" /><path d="m8 11 2 2 4-4" /></>,
  delete: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="m6 7 1 13h10l1-13" /></>,
  status: <circle cx="12" cy="12" r="2.5" fill="currentColor" />,
};

function ActivityGlyph({ icon, state }: { icon: ActivityIcon; state: ActivityState | undefined }) {
  const glyph = state === "running"
    ? <><circle cx="12" cy="12" r="8" opacity="0.25" /><path d="M20 12a8 8 0 0 0-8-8" /></>
    : state === "done"
      ? <path d="m5 12.5 4.5 4.5L19 7" />
      : state === "failed"
        ? <><path d="m7 7 10 10" /><path d="M17 7 7 17" /></>
        : GLYPHS[icon];
  return (
    <svg
      className="activity-icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {glyph}
    </svg>
  );
}
