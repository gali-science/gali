import type { CSSProperties, DragEvent, FormEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconChat, IconMic, IconMicOff, IconStopOutline } from "../../app/icons";
import { usePhoneShell } from "../../hooks/use-phone-shell";
import { OutputNotice, UploadNotice } from "../boot/DemoTerms";
import { ReviewGuide } from "../guide/ReviewGuide";
import { PillOrb } from "../voice/PillOrb";
import { VoiceIsland } from "../voice/VoiceIsland";
import { titleFromPdfName } from "../../../../shared/domain/project-title";
import { askTryQuestion, askTryTitle, TryBusyError, TryLimitError, type TryTurn } from "./try-api";
import { TryReader, type TryFile } from "./TryReader";
import { TryVoice } from "./try-voice";
import { useStreamLevel } from "./use-stream-level";
import "./try.css";

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const HISTORY_TURNS = 6;
const TITLE_INPUT_CHARS = 6_000;
const SPLIT_MIN = 0.15;
const SPLIT_MAX = 0.75;
const SPLITTER_PX = 12;

type Turn = TryTurn & { id: number };
type VoiceState = "off" | "connecting" | "on";

function PaperIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.5 7.2 16.4 12l-6.9 4.8Z" fill="currentColor" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  );
}

function pdfOf(files: FileList | null): File | null {
  const file = files?.[0];
  if (!file) return null;
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf") ? file : null;
}

function Conversation({
  turns,
  thinking,
  joinWaitlist,
}: {
  turns: readonly Turn[];
  thinking: boolean;
  joinWaitlist: (label: ReactNode, className: string) => ReactNode;
}) {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const box = list.current?.parentElement;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns.length, thinking]);

  return (
    <>
      <div className="try-empty-chat">
        <b>Ask anything by voice.</b>
        <span>Preview only, nothing is saved. {joinWaitlist("Join the waitlist", "try-inline-signin")} for full Gali.</span>
      </div>
      {turns.length === 0 ? null : (
        <div ref={list} className="thread is-clean" aria-live="polite">
          {turns.map((turn) => (
            <div key={turn.id} className={`bubble ${turn.role === "user" ? "u" : "a"}`}>{turn.text}</div>
          ))}
          {thinking ? <div className="bubble a try-thinking">Reading…</div> : null}
        </div>
      )}
    </>
  );
}

function GaliMark() {
  return (
    <svg className="try-mark" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M12 2.5a9.5 9.5 0 0 1 0 19z" fill="currentColor" />
    </svg>
  );
}

function SparkIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.5 14.2 9.8 21.5 12l-7.3 2.2L12 21.5l-2.2-7.3L2.5 12l7.3-2.2z" />
    </svg>
  );
}

function LimitCard({ joinWaitlist }: { joinWaitlist: (label: ReactNode, className: string) => ReactNode }) {
  return (
    <div className="try-zone try-limit" role="alert">
      <span className="try-badge" aria-hidden="true"><SparkIcon /></span>
      <h2>{"Your free demo is used\u00a0up"}</h2>
      {joinWaitlist("Join the waitlist to keep going", "try-pick")}
    </div>
  );
}

export function TryPage({ signIn, joinWaitlist }: {
  signIn: (label: ReactNode, className: string) => ReactNode;
  joinWaitlist: (label: ReactNode, className: string) => ReactNode;
}) {
  const [file, setFile] = useState<TryFile | null>(null);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [fileText, setFileText] = useState<{ text: string; pageCount: number } | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>("off");
  const [speaking, setSpeaking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [toolPulse, setToolPulse] = useState(0);
  const [pendingTool, setPendingTool] = useState<string | null>(null);
  const [voiceTried, setVoiceTried] = useState(false);
  const [limited, setLimited] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const phone = usePhoneShell();
  const [view, setView] = useState<"paper" | "chat">("paper");
  const [seenTurns, setSeenTurns] = useState(0);
  const [split, setSplit] = useState<number | null>(null);
  const work = useRef<HTMLElement | null>(null);
  const resizing = useRef(false);
  const picker = useRef<HTMLInputElement | null>(null);
  const voice = useRef<TryVoice | null>(null);
  const nextId = useRef(1);
  const live = useRef({ page, fileText, file });
  live.current = { page, fileText, file };
  const micStream = useCallback(() => voice.current?.micStream() ?? null, []);
  const remoteStream = useCallback(() => voice.current?.remoteStream() ?? null, []);
  const inputLevel = useStreamLevel(micStream, voiceState === "on" && !muted, 0.015, 5.5);
  const outputLevel = useStreamLevel(remoteStream, voiceState === "on", 0.01, 6);

  const addTurn = useCallback((role: Turn["role"], text: string) => {
    setTurns((all) => [...all, { id: nextId.current++, role, text }]);
  }, []);

  const endVoice = useCallback(() => {
    voice.current?.close(null);
  }, []);

  const hitLimit = useCallback(() => {
    voice.current?.close(null);
    setLimited(true);
  }, []);

  useEffect(() => () => voice.current?.close(null), []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const host = work.current;
      if (!resizing.current || !host) return;
      const rect = host.getBoundingClientRect();
      const style = getComputedStyle(host);
      const left = rect.left + parseFloat(style.paddingLeft);
      const width = rect.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setSplit(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, (event.clientX - left) / width)));
    };
    const onUp = () => {
      if (!resizing.current) return;
      resizing.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resizing.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  useEffect(() => {
    if (view === "chat") setSeenTurns(turns.length);
  }, [view, turns.length]);

  useEffect(() => {
    if (error || limited) setView("chat");
  }, [error, limited]);

  useEffect(() => {
    const firstPage = fileText?.text.split(/^=== page \d+.*===$/m)[1]?.trim().slice(0, TITLE_INPUT_CHARS);
    if (!firstPage) return;
    let current = true;
    askTryTitle(firstPage)
      .then((found) => {
        if (current) setTitle(found);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [fileText]);

  const open = useCallback(async (source: Promise<{ name: string; data: ArrayBuffer }>) => {
    setError("");
    try {
      const { name, data } = await source;
      if (data.byteLength > MAX_FILE_BYTES) throw new Error("That PDF is over 100 MB.");
      endVoice();
      setTurns([]);
      setSeenTurns(0);
      setView("paper");
      setVoiceTried(false);
      setTitle(null);
      setFileText(null);
      setPage(1);
      setFile({ id: `${name}:${Date.now()}`, name, data });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [endVoice]);

  const openLocal = useCallback((files: FileList | null) => {
    const pdf = pdfOf(files);
    if (!pdf) {
      setError("Drop a PDF: a paper or a slide deck.");
      return;
    }
    void open(pdf.arrayBuffer().then((data) => ({ name: pdf.name, data })));
  }, [open]);

  const closeFile = useCallback(() => {
    endVoice();
    setFile(null);
    setTitle(null);
    setFileText(null);
    setTurns([]);
    setSeenTurns(0);
    setView("paper");
    setDraft("");
    setError("");
  }, [endVoice]);

  const ask = useCallback((question: string, history: readonly TryTurn[]) => {
    const current = live.current;
    if (!current.fileText) throw new Error("The file's text is not read yet.");
    return askTryQuestion({ question, fileText: current.fileText.text, page: current.page, history })
      .catch((cause: unknown) => {
        if (cause instanceof TryLimitError) hitLimit();
        throw cause;
      });
  }, [hitLimit]);

  const turnPage = useCallback((target: { page?: number; direction?: "next" | "prev" }) => {
    const { page: current, fileText: text } = live.current;
    const last = text?.pageCount ?? 1;
    const wanted = target.page ?? (target.direction === "next" ? current + 1 : target.direction === "prev" ? current - 1 : current);
    const next = Math.min(Math.max(1, wanted), last);
    setPage(next);
    return next;
  }, []);

  const startVoice = useCallback(async () => {
    const current = live.current;
    if (!current.file || !current.fileText) return;
    setError("");
    setVoiceTried(true);
    setVoiceState("connecting");
    const session = new TryVoice({
      onUserText: (text) => addTurn("user", text),
      onAssistantText: (text) => addTurn("assistant", text),
      onSpeaking: setSpeaking,
      onTool: (name) => {
        if (name) setToolPulse((count) => count + 1);
        setPendingTool(name);
      },
      onEnded: (message) => {
        if (voice.current === session) voice.current = null;
        setVoiceState("off");
        setMuted(false);
        setPendingTool(null);
        if (message) setError(message);
      },
      onLimit: hitLimit,
      answer: (question) => ask(question, []),
      turnPage,
    });
    voice.current = session;
    try {
      await session.connect();
      session.note(`The user opened "${current.file.name}", ${current.fileText.pageCount} pages, and is on page ${live.current.page}.`);
      setVoiceState("on");
    } catch (cause) {
      if (cause instanceof TryLimitError) {
        hitLimit();
        return;
      }
      if (cause instanceof TryBusyError) {
        session.close(cause.message);
        return;
      }
      session.close(cause instanceof Error && cause.name === "NotAllowedError"
        ? "Gali needs the microphone to talk. You can still type."
        : `Voice could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }, [addTurn, ask, hitLimit, turnPage]);

  useEffect(() => {
    if (voiceState !== "on" || !fileText) return;
    const timer = window.setTimeout(() => {
      voice.current?.note(`The user is now on page ${page} of ${fileText.pageCount}.`);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [page, voiceState, fileText]);

  const send = useCallback((typed: string) => {
    const question = typed.trim();
    if (!question || thinking || !live.current.fileText) return false;
    if (voice.current && voiceState === "on") {
      addTurn("user", question);
      voice.current.sendText(question);
      return true;
    }
    const history = turns.slice(-HISTORY_TURNS).map(({ role, text }) => ({ role, text }));
    addTurn("user", question);
    setThinking(true);
    setError("");
    ask(question, history)
      .then((answer) => addTurn("assistant", answer))
      .catch((cause: unknown) => {
        if (!(cause instanceof TryLimitError)) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setThinking(false));
    return true;
  }, [addTurn, ask, thinking, turns, voiceState]);

  const submit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (send(draft)) setDraft("");
  }, [draft, send]);

  const toggleVoice = useCallback(() => {
    if (voiceState === "off") void startVoice();
    else endVoice();
  }, [endVoice, startVoice, voiceState]);

  const toggleMute = useCallback(() => {
    voice.current?.setMuted(!muted);
    setMuted(!muted);
  }, [muted]);

  useEffect(() => {
    if (!fileText || limited) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.code === "Space") {
        event.preventDefault();
        toggleVoice();
      } else if (event.code === "KeyM" && voiceState === "on") {
        event.preventDefault();
        toggleMute();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fileText, limited, toggleMute, toggleVoice, voiceState]);

  const onDrop = useCallback((event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!limited) openLocal(event.dataTransfer.files);
  }, [limited, openLocal]);

  const ready = fileText !== null;
  const close = file ? (
    <button
      type="button"
      className="try-close"
      onClick={closeFile}
      aria-label="Close this file"
      title="Close this file"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  ) : null;
  const talk = (className: string, icon: ReactNode) => (
    <button
      type="button"
      className={`${className}${ready && !voiceTried && turns.length === 0 ? " is-inviting" : ""}`}
      disabled={!ready}
      onClick={() => void startVoice()}
      aria-label="Talk to Gali"
    >
      {icon}
    </button>
  );
  const askBox = (
    <label className={`try-ask${draft ? " is-typing" : ""}`}>
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={voiceState === "on" ? "Type or just talk…" : "Ask about this file…"}
        aria-label="Ask about this file"
        disabled={!ready}
      />
      {voiceState === "on" ? (
        <span className={`try-wave${speaking ? " is-speaking" : ""}`} aria-hidden="true">
          <i /><i /><i /><i />
        </span>
      ) : null}
      {draft.trim() ? (
        <button type="submit" className="try-send" aria-label="Send" disabled={thinking}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6" /></svg>
        </button>
      ) : null}
    </label>
  );
  return (
    <main
      className={`try-page${phone ? " is-phone" : ""}${file === null ? " is-start" : ""}${dragging ? " is-dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        if (!limited) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header className="try-top">
        {phone && close ? close : <GaliMark />}
        <span className="try-name">{file ? title ?? titleFromPdfName(file.name) : "Gali"}</span>
        {phone ? null : close}
        <span className="try-spacer" />
        {file ? null : (
          <button type="button" className="try-about try-guide" onClick={() => setGuideOpen(true)}>
            {phone ? "Guide" : "Reviewing with AI"}
          </button>
        )}
        {file ? null : <a className="try-about" href="/about/">About</a>}
        {signIn("Sign in", "try-signin")}
      </header>

      <input
        ref={picker}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(event) => {
          openLocal(event.target.files);
          event.target.value = "";
        }}
      />

      {file === null ? (
        <section className="try-start">
          <div className="try-hero">
            <h1 className="try-title">
              {"Learn\u00a0it. Review\u00a0it. "}
              <em>{"Out\u00a0loud."}</em>
            </h1>
            {limited ? (
              <>
                <LimitCard joinWaitlist={joinWaitlist} />
                <UploadNotice />
              </>
            ) : (
              <>
                <div className="try-zone">
                  <span className="try-badge" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 15V5M8 9l4-4 4 4" /><path d="M5 19h14" /></svg>
                  </span>
                  <h2>Drop a PDF</h2>
                  <p>Paper, slides, or notes</p>
                  <button type="button" className="try-pick" onClick={() => picker.current?.click()}>Choose file</button>
                </div>
                {error ? <p className="try-error" role="alert">{error}</p> : null}
                <UploadNotice />
                {joinWaitlist(
                  <>
                    <SparkIcon className="try-spark" />
                    Join the waitlist for Gali's full agent
                    <svg className="try-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                  </>,
                  "try-agent",
                )}
              </>
            )}
          </div>
        </section>
      ) : (
        <>
          <section
            ref={work}
            className={`try-work${phone ? ` is-${view}` : ""}`}
            style={split === null || phone
              ? undefined
              : { "--try-columns": `minmax(0, ${split}fr) ${SPLITTER_PX}px minmax(0, ${1 - split}fr)` } as CSSProperties}
          >
            <div className="try-source">
              <TryReader
                file={file}
                page={page}
                onPageChange={setPage}
                onText={setFileText}
                onError={setError}
              />
            </div>
            {phone ? null : (
              <div
                className="review-splitter try-splitter"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panels"
                onPointerDown={startResize}
              />
            )}
            <aside className="try-side" aria-label="Conversation">
              <div className="try-side-card">
                <div className="try-side-scroll">
                  {ready
                    ? <Conversation turns={turns} thinking={thinking} joinWaitlist={joinWaitlist} />
                    : <div className="try-empty-chat"><b>Reading the file…</b></div>}
                </div>
                <OutputNotice />
                {error && !limited ? <p className="try-error is-side" role="alert">{error}</p> : null}
                {limited ? <LimitCard joinWaitlist={joinWaitlist} /> : phone ? (
                  <form className="try-bar" onSubmit={submit}>{askBox}</form>
                ) : null}
              </div>
              {limited || phone ? null : (
                <div className={`try-bar is-island${ready && !voiceTried && turns.length === 0 ? " is-inviting" : ""}`}>
                  <VoiceIsland
                    connected={voiceState === "on"}
                    connecting={voiceState === "connecting"}
                    muted={muted}
                    error={null}
                    inputLevel={inputLevel}
                    outputLevel={outputLevel}
                    pendingTool={pendingTool}
                    toolPulse={toolPulse}
                    disabled={!ready}
                    onToggle={toggleVoice}
                    onMute={toggleMute}
                    onClearError={() => {}}
                    onSend={(text) => send(text) ? Promise.resolve() : Promise.reject(new Error("not sent"))}
                  />
                </div>
              )}
            </aside>
          </section>
          {phone ? (
            <nav className="try-dock" aria-label="PDF, chat and voice">
              <button
                type="button"
                className={`try-dock-btn${view === "paper" ? " on" : ""}`}
                aria-pressed={view === "paper"}
                aria-label="PDF"
                title="PDF"
                onClick={() => setView("paper")}
              >
                <PaperIcon />
              </button>
              <button
                type="button"
                className={`try-dock-btn${view === "chat" ? " on" : ""}`}
                aria-pressed={view === "chat"}
                aria-label={view === "paper" && turns.length > seenTurns ? "Chat, new reply" : "Chat"}
                title="Chat"
                onClick={() => setView("chat")}
              >
                <IconChat />
                {view === "paper" && turns.length > seenTurns ? <span className="try-dock-dot" aria-hidden="true" /> : null}
              </button>
              <div className="try-dock-center">
                {voiceState === "on" ? (
                  <div className="try-dock-live" role="status" aria-label={muted ? "Voice live, mic muted" : "Voice live"}>
                    <PillOrb state={muted ? "idle" : outputLevel > 0.04 ? "talking" : "listening"} volume={outputLevel} toolPulse={toolPulse} centered />
                  </div>
                ) : voiceState === "connecting" ? (
                  <button type="button" className="try-dock-talk is-connecting" disabled aria-label="Connecting">
                    <PlayIcon />
                  </button>
                ) : talk("try-dock-talk", <PlayIcon />)}
              </div>
              <button
                type="button"
                className={`try-dock-btn${muted ? " on" : ""}`}
                disabled={voiceState !== "on"}
                onClick={toggleMute}
                aria-label={muted ? "Unmute mic" : "Mute mic"}
                aria-pressed={muted}
                title={muted ? "Unmute mic" : "Mute mic"}
              >
                {muted ? <IconMicOff /> : <IconMic />}
              </button>
              <button
                type="button"
                className="try-dock-btn"
                disabled={voiceState === "off"}
                onClick={endVoice}
                aria-label="End voice"
                title="End voice"
              >
                <IconStopOutline />
              </button>
            </nav>
          ) : null}
        </>
      )}
      {dragging ? <div className="try-drop-veil" aria-hidden="true">Drop to open</div> : null}
      {guideOpen ? <ReviewGuide onClose={() => setGuideOpen(false)} /> : null}
    </main>
  );
}
