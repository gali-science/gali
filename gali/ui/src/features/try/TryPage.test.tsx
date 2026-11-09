import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TryPage } from "./TryPage";

vi.mock("./TryReader", () => ({
  TryReader: ({ page, onText }: { page: number; onText: (text: { text: string; pageCount: number }) => void }) => {
    useEffect(() => onText({ text: "=== page 1 ===\nλ weights the balance term.", pageCount: 3 }), [onText]);
    return <div>Reader on page {page}</div>;
  },
}));

const micTrack = vi.hoisted(() => ({ enabled: true, stop: () => {} }));
const titles = vi.hoisted(() => ({ found: null as string | null, asked: [] as string[] }));

vi.mock("./try-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./try-api")>()),
  askTryTitle: async (firstPage: string) => {
    titles.asked.push(firstPage);
    return titles.found;
  },
}));

const server = vi.hoisted(() => ({ say: (_event: unknown) => {} }));

vi.mock("../../realtime/rtc-session", () => ({
  connectRtcSession: async ({ onCreated, exchange, onTrack, onMessage }: {
    onCreated: (session: unknown) => void;
    exchange: (offer: string) => Promise<string>;
    onTrack: (stream: unknown) => void;
    onMessage: (data: unknown) => void;
  }) => {
    const session = {
      pc: { connectionState: "connected", addEventListener: () => {}, close: () => {} },
      dc: { readyState: "open", send: () => {}, close: () => {} },
      mic: { getTracks: () => [micTrack] },
    };
    onCreated(session);
    await exchange("offer-sdp");
    onTrack({ remote: true });
    server.say = onMessage;
    return session;
  },
}));

vi.mock("../voice/PillOrb", () => ({
  PillOrb: ({ state, volume, toolPulse }: { state: string; volume: number; toolPulse: number }) => (
    <i className="orb-probe" data-state={state} data-volume={volume} data-pulse={toolPulse} />
  ),
}));

const micSample = vi.hoisted(() => ({ value: 128 }));
const speakerSample = vi.hoisted(() => ({ value: 128 }));

class FakeAudioContext {
  private remote = false;
  createMediaStreamSource(stream: { remote?: boolean }) {
    this.remote = stream.remote === true;
    return { connect: () => {}, disconnect: () => {} };
  }
  createAnalyser() {
    const sample = () => (this.remote ? speakerSample.value : micSample.value);
    return { fftSize: 0, smoothingTimeConstant: 0, getByteTimeDomainData: (samples: Uint8Array) => samples.fill(sample()) };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

beforeEach(() => {
  micSample.value = 128;
  speakerSample.value = 128;
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  titles.found = null;
  titles.asked = [];
});

const signInButton = (label: ReactNode, className: string) => <button type="button" className={className}>{label}</button>;

function route(handlers: Record<string, () => Response>) {
  const fetchMock = vi.fn(async (url: string) => handlers[url]!());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function openPdf() {
  await act(async () => {
    fireEvent.drop(screen.getByRole("main"), { dataTransfer: { files: [pdf()] } });
  });
  await screen.findByRole("textbox", { name: /^Ask (Gali|about this file)$/ });
}

function expectLimitCard() {
  expect(screen.getByRole("heading", { name: "Your free demo is used\u00a0up" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Join the waitlist to keep going" })).toBeTruthy();
}

test("a spent voice hour swaps the ask bar for the sign-in card, and the drop page keeps it", async () => {
  const fetchMock = route({
    "/api/try/session": () => Response.json({ error: "Your free demo is used up." }, { status: 429 }),
  });
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();

  await userEvent.click(screen.getByRole("button", { name: "Start voice (Ctrl+Space)" }));

  expectLimitCard();
  expect(screen.queryByRole("textbox", { name: "Ask Gali" })).toBeNull();
  expect(screen.queryByText("Your free demo is used up.")).toBeNull();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/try/session"]);

  await userEvent.click(screen.getByRole("button", { name: "Close this file" }));
  expectLimitCard();
  expect(screen.queryByRole("heading", { name: "Drop a PDF" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Join the waitlist for Gali's full agent" })).toBeNull();
  expect(screen.getByRole("button", { name: "Demo Terms" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Privacy Notice" })).toBeTruthy();
  await act(async () => {
    fireEvent.drop(screen.getByRole("main"), { dataTransfer: { files: [pdf()] } });
  });
  expect(screen.queryByText(/Reader on page/)).toBeNull();
});

test("a network with too many open calls says to try again, and typing still works", async () => {
  const busy = "Too many voice calls are open on your network right now. Try again in a few minutes, or type your question.";
  route({
    "/api/try/session": () => Response.json({ error: busy, busy: true }, { status: 429 }),
    "/api/try/answer": () => Response.json({ answer: "It weights the balance term." }),
  });
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();

  await userEvent.click(screen.getByRole("button", { name: "Start voice (Ctrl+Space)" }));

  expect((await screen.findByRole("alert")).textContent).toBe(busy);
  expect(screen.queryByRole("button", { name: "Join the waitlist to keep going" })).toBeNull();
  expect(screen.getByRole("button", { name: "Start voice (Ctrl+Space)" })).toBeTruthy();
  await userEvent.type(screen.getByRole("textbox", { name: "Ask Gali" }), "What is lambda?{Enter}");
  expect(await screen.findByText("It weights the balance term.")).toBeTruthy();
});

test("a refused typed answer shows the sign-in card", async () => {
  route({ "/api/try/answer": () => Response.json({ error: "Your free demo is used up." }, { status: 429 }) });
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();

  await userEvent.type(screen.getByRole("textbox", { name: "Ask Gali" }), "What is lambda?{Enter}");

  expect(await screen.findByRole("button", { name: "Join the waitlist to keep going" })).toBeTruthy();
  expectLimitCard();
});

test("the play button pulses until the first turn, and a live call offers mute and stop", async () => {
  micTrack.enabled = true;
  const fetchMock = route({
    "/api/try/session": () => Response.json({ sdp: "answer-sdp", call: "rtc_1" }),
    "/api/try/end": () => Response.json({ ok: true }),
  });
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();
  expect(screen.getByRole("button", { name: "Start voice (Ctrl+Space)" }).closest(".try-bar")!.className).toContain("is-inviting");

  await userEvent.click(screen.getByRole("button", { name: "Start voice (Ctrl+Space)" }));
  await screen.findByRole("button", { name: "End voice (Ctrl+Space)" });
  await userEvent.click(screen.getByRole("button", { name: "Mute mic (Ctrl+M)" }));

  expect(micTrack.enabled).toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Unmute mic (Ctrl+M)" }));
  expect(micTrack.enabled).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "End voice (Ctrl+Space)" }));
  expect(screen.getByRole("button", { name: "Start voice (Ctrl+Space)" }).closest(".try-bar")!.className).not.toContain("is-inviting");
  expect(screen.queryByRole("button", { name: "Mute mic (Ctrl+M)" })).toBeNull();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/try/session", "/api/try/end"]);
});

test("on desktop the ask bar is the signed-in voice capsule, driven by the real mic level and shortcuts", async () => {
  micTrack.enabled = true;
  route({
    "/api/try/session": () => Response.json({ sdp: "answer-sdp", call: "rtc_1" }),
    "/api/try/end": () => Response.json({ ok: true }),
  });
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();
  const capsule = screen.getByRole("group", { name: "Gali voice" });
  const island = capsule.closest(".voice-island.is-docked")!;
  const state = () => capsule.querySelector(".voice-island-state")?.textContent;
  expect(capsule.contains(screen.getByRole("textbox", { name: "Ask Gali" }))).toBe(true);
  expect(capsule.contains(screen.getByRole("button", { name: "Start voice (Ctrl+Space)" }))).toBe(true);

  fireEvent.keyDown(window, { code: "Space", ctrlKey: true });
  await screen.findByRole("button", { name: "End voice (Ctrl+Space)" });
  await waitFor(() => expect(state()).toBe("Ready"), { timeout: 4000 });
  expect(island.getAttribute("data-phase")).toBe("idle");

  micSample.value = 200;
  await waitFor(() => expect(state()).toBe("Listening"), { timeout: 4000 });
  expect(island.getAttribute("data-phase")).toBe("hear");

  fireEvent.keyDown(window, { code: "KeyM", ctrlKey: true });
  expect(micTrack.enabled).toBe(false);
  await waitFor(() => expect(state()).toBe("Muted"));
  expect(island.getAttribute("data-phase")).toBe("muted");

  fireEvent.keyDown(window, { code: "Space", ctrlKey: true });
  expect(await screen.findByRole("button", { name: "Start voice (Ctrl+Space)" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Mute mic (Ctrl+M)" })).toBeNull();
}, 15_000);

test("a live call pays ahead every minute, and a refused payment ends it with the sign-in card", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let payments = 0;
  const fetchMock = route({
    "/api/try/session": () => Response.json({ sdp: "answer-sdp", call: "rtc_1" }),
    "/api/try/extend": () => (payments += 1) === 1
      ? Response.json({ ok: true })
      : Response.json({ error: "Your free demo is used up." }, { status: 429 }),
    "/api/try/end": () => Response.json({ ok: true }),
  });
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();
  await userEvent.click(screen.getByRole("button", { name: "Start voice (Ctrl+Space)" }));
  await screen.findByRole("button", { name: "End voice (Ctrl+Space)" });

  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/try/session", "/api/try/extend"]);
  expect(screen.getByRole("button", { name: "End voice (Ctrl+Space)" })).toBeTruthy();

  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(await screen.findByRole("button", { name: "Join the waitlist to keep going" })).toBeTruthy();
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    "/api/try/session",
    "/api/try/extend",
    "/api/try/extend",
    "/api/try/end",
  ]);
  expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ call: "rtc_1" });
  await act(async () => {
    vi.advanceTimersByTime(180_000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(4);
});

test("leaving the page during a call tells the server so it can hang up", async () => {
  const fetchMock = route({
    "/api/try/session": () => Response.json({ sdp: "answer-sdp", call: "rtc_1" }),
    "/api/try/end": () => Response.json({ ok: true }),
  });
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();
  await userEvent.click(screen.getByRole("button", { name: "Start voice (Ctrl+Space)" }));
  await screen.findByRole("button", { name: "End voice (Ctrl+Space)" });

  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });

  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/try/session", "/api/try/end"]);
  window.dispatchEvent(new Event("pagehide"));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

function pdf(name = "paper.pdf") {
  return new File([new Uint8Array([37, 80, 68, 70])], name, { type: "application/pdf" });
}

test("the drop page names learning, review and voice, and offers sign-in for the agent", () => {
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);

  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Learn\u00a0it. Review\u00a0it. Out\u00a0loud.");
  expect(screen.getByRole("heading", { name: "Drop a PDF" })).toBeTruthy();
  expect(screen.getByText("Paper, slides, or notes")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Choose file" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "About" }).nextElementSibling).toBe(screen.getByRole("button", { name: "Sign in" }));
  expect(screen.getByRole("button", { name: "Join the waitlist for Gali's full agent" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /sample/i })).toBeNull();
});

test("the drop page says it is a research preview and links the terms once", () => {
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);

  expect(screen.getByText("Research preview. Do not upload confidential information.")).toBeTruthy();
  expect(screen.getByText(/By uploading, you agree to the/)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /terms/i }).map((link) => link.textContent)).toEqual(["Demo Terms"]);
  expect(screen.getAllByRole("button", { name: /privacy/i }).map((link) => link.textContent)).toEqual(["Privacy Notice"]);
});

test("an open file says it is a preview and keeps offering the waitlist above the conversation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ answer: "It weights the balance term." })));
  const waitlistLink = (label: ReactNode, className: string) => <a href="#waitlist" className={className}>{label}</a>;
  render(<TryPage signIn={signInButton} joinWaitlist={waitlistLink} />);
  await openPdf();

  expect(screen.getByText("Ask anything by voice.")).toBeTruthy();
  expect(screen.getByText(/Preview only, nothing is saved\./)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
  expect(screen.getAllByRole("link", { name: "Join the waitlist" })).toHaveLength(1);

  await userEvent.type(screen.getByRole("textbox", { name: "Ask Gali" }), "What is lambda?{Enter}");
  await screen.findByText("It weights the balance term.");

  const intro = screen.getByText("Ask anything by voice.").parentElement!;
  expect(screen.getByText(/Preview only, nothing is saved\./)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
  expect(screen.getAllByRole("link", { name: "Join the waitlist" })).toHaveLength(1);
  expect(intro.compareDocumentPosition(screen.getByText("It weights the balance term.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByRole("complementary", { name: "Conversation" }).textContent)
    .toContain("Gali can make mistakes. Verify before relying on it.");
});

test("dropping a PDF opens it, and a typed question is answered by the fast model", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ answer: "It weights the balance term." }));
  vi.stubGlobal("fetch", fetchMock);
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);

  expect(screen.queryByText(/Nothing is saved/)).toBeNull();
  await act(async () => {
    fireEvent.drop(screen.getByRole("main"), { dataTransfer: { files: [pdf()] } });
  });
  expect(await screen.findByText("Reader on page 1")).toBeTruthy();
  expect(screen.getByText("paper")).toBeTruthy();

  await userEvent.type(screen.getByRole("textbox", { name: "Ask Gali" }), "What is lambda?{Enter}");

  expect((await screen.findByText("It weights the balance term.")).className).toBe("bubble a");
  expect(screen.getByText("What is lambda?").className).toBe("bubble u");
  expect(screen.getByText("What is lambda?").parentElement!.className).toBe("thread is-clean");
  expect(screen.queryByText("Page 1")).toBeNull();
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/try/answer");
  expect(JSON.parse(String(init.body))).toEqual({
    question: "What is lambda?",
    fileText: "=== page 1 ===\nλ weights the balance term.",
    page: 1,
    history: [],
  });
});

test("a follow-up carries the earlier turns", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ answer: "It routes frames to experts." }))
    .mockResolvedValueOnce(Response.json({ answer: "By 1.8 points." }));
  vi.stubGlobal("fetch", fetchMock);
  render(<TryPage signIn={() => null} joinWaitlist={() => null} />);
  await act(async () => {
    fireEvent.drop(screen.getByRole("main"), { dataTransfer: { files: [pdf()] } });
  });
  const box = await screen.findByRole("textbox", { name: "Ask Gali" });

  await userEvent.type(box, "Summarize it{Enter}");
  await screen.findByText("It routes frames to experts.");
  await userEvent.type(box, "And on the test set?{Enter}");
  await screen.findByText("By 1.8 points.");

  const second = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as { history: unknown };
  expect(second.history).toEqual([
    { role: "user", text: "Summarize it" },
    { role: "assistant", text: "It routes frames to experts." },
  ]);
});

test("the header shows the file name without .pdf, then the paper's title read from its first page", async () => {
  titles.found = "Attention Is All You Need";
  render(<TryPage signIn={() => null} joinWaitlist={() => null} />);
  expect(screen.getByText("Gali")).toBeTruthy();

  await act(async () => {
    fireEvent.drop(screen.getByRole("main"), { dataTransfer: { files: [pdf("attention_is-all.pdf")] } });
  });

  expect(await screen.findByText("Attention Is All You Need")).toBeTruthy();
  expect(titles.asked).toEqual(["λ weights the balance term."]);
  await userEvent.click(screen.getByRole("button", { name: "Close this file" }));
  expect(screen.queryByText("Attention Is All You Need")).toBeNull();
});

test("without a title the header shows the file name without .pdf", async () => {
  render(<TryPage signIn={() => null} joinWaitlist={() => null} />);

  await act(async () => {
    fireEvent.drop(screen.getByRole("main"), { dataTransfer: { files: [pdf("attention_is-all.pdf")] } });
  });

  expect(await screen.findByText("attention is all")).toBeTruthy();
  expect(screen.queryByText("attention_is-all.pdf")).toBeNull();
});

test("a file that is not a PDF is refused", async () => {
  render(<TryPage signIn={() => null} joinWaitlist={() => null} />);
  await act(async () => {
    fireEvent.drop(screen.getByRole("main"), {
      dataTransfer: { files: [new File(["hi"], "notes.txt", { type: "text/plain" })] },
    });
  });
  expect(screen.getByRole("alert").textContent).toMatch(/Drop a PDF/);
  expect(screen.queryByText(/Reader on page/)).toBeNull();
});

function onPhone() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(max-width: 768px)",
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

test("on a phone the paper and chat swap from a dock with voice in the middle", async () => {
  onPhone();
  micTrack.enabled = true;
  route({
    "/api/try/answer": () => Response.json({ answer: "It weights the balance term." }),
    "/api/try/session": () => Response.json({ sdp: "answer-sdp", call: "rtc_1" }),
    "/api/try/end": () => Response.json({ ok: true }),
  });
  const { container } = render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();

  const dock = screen.getByRole("navigation", { name: "PDF, chat and voice" });
  const work = container.querySelector(".try-work")!;
  expect(work.className).toContain("is-paper");
  expect(screen.getByRole("button", { name: "PDF" }).getAttribute("aria-pressed")).toBe("true");
  expect(dock.contains(screen.getByRole("button", { name: "Talk to Gali" }))).toBe(true);
  expect((screen.getByRole("button", { name: "Mute mic" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "End voice" }) as HTMLButtonElement).disabled).toBe(true);

  await userEvent.click(screen.getByRole("button", { name: "Chat" }));
  expect(work.className).toContain("is-chat");
  await userEvent.type(screen.getByRole("textbox", { name: "Ask about this file" }), "What is lambda?{Enter}");
  await screen.findByText("It weights the balance term.");

  await userEvent.click(screen.getByRole("button", { name: "PDF" }));
  await userEvent.click(screen.getByRole("button", { name: "Talk to Gali" }));
  expect(await screen.findByRole("status", { name: "Voice live" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Mute mic" }));
  expect(micTrack.enabled).toBe(false);
  expect(screen.getByRole("status", { name: "Voice live, mic muted" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "End voice" }));
  expect(screen.getByRole("button", { name: "Talk to Gali" })).toBeTruthy();
  expect(work.className).toContain("is-paper");
});

test("on a phone the dock starts with play, and the live orb follows Gali's voice and tool calls", async () => {
  onPhone();
  micTrack.enabled = true;
  route({
    "/api/try/session": () => Response.json({ sdp: "answer-sdp", call: "rtc_1" }),
    "/api/try/end": () => Response.json({ ok: true }),
  });
  render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();
  const icon = (name: string) => screen.getByRole("button", { name }).querySelector("path")!.getAttribute("d");
  expect(icon("Talk to Gali")).toBe("M9.5 7.2 16.4 12l-6.9 4.8Z");
  expect(icon("Talk to Gali")).not.toBe(icon("Mute mic"));

  await userEvent.click(screen.getByRole("button", { name: "Talk to Gali" }));
  const live = await screen.findByRole("status", { name: "Voice live" });
  const orb = () => live.querySelector(".orb-probe")!;
  expect(orb().getAttribute("data-state")).toBe("listening");
  expect(orb().getAttribute("data-volume")).toBe("0");

  speakerSample.value = 200;
  await waitFor(() => expect(orb().getAttribute("data-state")).toBe("talking"));
  expect(Number(orb().getAttribute("data-volume"))).toBeGreaterThan(0.5);

  await act(async () => {
    server.say({
      type: "response.done",
      response: { output: [{ type: "function_call", call_id: "c1", name: "set_viewer_page", arguments: JSON.stringify({ page: 2 }) }] },
    });
  });
  await waitFor(() => expect(orb().getAttribute("data-pulse")).toBe("1"));
});

test("on a phone a reply that lands while reading the paper marks the chat, and the limit card opens it", async () => {
  onPhone();
  let answer: (response: Response) => void = () => {};
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url === "/api/try/answer"
    ? new Promise<Response>((done) => { answer = done; })
    : Response.json({ error: "Your free demo is used up." }, { status: 429 })));
  const { container } = render(<TryPage signIn={signInButton} joinWaitlist={signInButton} />);
  await openPdf();
  await userEvent.click(screen.getByRole("button", { name: "Chat" }));
  await userEvent.type(screen.getByRole("textbox", { name: "Ask about this file" }), "What is lambda?{Enter}");
  await userEvent.click(screen.getByRole("button", { name: "PDF" }));
  expect(screen.getByRole("button", { name: "Chat" })).toBeTruthy();
  await act(async () => answer(Response.json({ answer: "It weights the balance term." })));
  await screen.findByText("It weights the balance term.");

  expect(screen.getByRole("button", { name: "Chat, new reply" })).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Chat, new reply" }));
  expect(screen.getByRole("button", { name: "Chat" })).toBeTruthy();

  await userEvent.click(screen.getByRole("button", { name: "PDF" }));
  await userEvent.click(screen.getByRole("button", { name: "Talk to Gali" }));
  await waitFor(() => expect(container.querySelector(".try-work")!.className).toContain("is-chat"));
  expectLimitCard();
});

test("closing the file goes back to the drop page and forgets the conversation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ answer: "Yes." })));
  render(<TryPage signIn={() => null} joinWaitlist={() => null} />);
  await act(async () => {
    fireEvent.drop(screen.getByRole("main"), { dataTransfer: { files: [pdf()] } });
  });
  await userEvent.type(await screen.findByRole("textbox", { name: "Ask Gali" }), "Is it?{Enter}");
  await screen.findByText("Yes.");

  await userEvent.click(screen.getByRole("button", { name: "Close this file" }));

  expect(screen.getByRole("heading", { name: "Drop a PDF" })).toBeTruthy();
  expect(screen.queryByText("Yes.")).toBeNull();
});
