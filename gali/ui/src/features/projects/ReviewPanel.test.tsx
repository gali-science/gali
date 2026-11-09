import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ReviewDto, ReviewFinding } from "../../../../shared/domain/contracts";
import { Figure, ReviewPanel } from "./ReviewPanel";

const api = vi.hoisted(() => ({ projectEvents: [] as Array<(event: { projectKey: string; seq: number }) => void> }));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  onProjectEvent: (emit: (event: { projectKey: string; seq: number }) => void) => {
    api.projectEvents.push(emit);
    return () => {};
  },
  readProjectMedia: async () => ({ data: new Uint8Array([1]), mime: "image/png" }),
}));

afterEach(() => {
  cleanup();
});

const serious: ReviewFinding = {
  id: "layers",
  severity: "serious",
  title: "Layer selection reuses the evaluation labels",
  body: "Each acoustic model receives 24 opportunities.",
  refs: [
    { paper: { page: 4, quote: "we select the best layer" } },
    { code: { path: "code/process_clust.py", lines: [163, 185] } },
  ],
  visuals: [],
};
const minor: ReviewFinding = {
  id: "variation",
  severity: "minor",
  title: "Layer variation does not establish superiority",
  body: "The reported standard deviation describes layers.",
  refs: [{ paper: { page: 4, quote: "standard deviation of 0.09" } }],
  visuals: [],
};
const anchor = { page: 4, pageWidth: 612, pageHeight: 792, rects: [] };
const review: ReviewDto = {
  document: { title: "Correctness review", findings: [serious, minor] },
  updatedAt: "2026-10-15T00:00:00.000Z",
  problems: [],
  anchors: { "layers:0": anchor, "variation:0": anchor },
  dismissed: [],
};

function renderPanel({ shown = review, canNote }: { shown?: ReviewDto | null; canNote?: boolean } = {}) {
  const props = {
    onPaperRef: vi.fn(),
    onCodeRef: vi.fn(),
    onAddToNotes: vi.fn(async () => {}),
    onRemoveFromNotes: vi.fn(async () => {}),
    onDismiss: vi.fn(async () => {}),
  };
  render(
    <ReviewPanel
      projectKey="alpha"
      review={shown}
      error=""
      canNote={canNote}
      notedFindings={new Set(["layers"])}
      focusFinding={null}
      onRestore={vi.fn(async () => {})}
      {...props}
    />,
  );
  const card = (title: string) => screen.queryByRole("heading", { name: title })?.closest("article") as HTMLElement;
  return { props, seriousCard: card(serious.title), minorCard: card(minor.title) };
}

test("with no review yet, the panel says so", () => {
  renderPanel({ shown: null });
  expect(screen.getByText("No findings yet")).toBeTruthy();
});

test("the review speaks of Gali, never of a separate reviewer", () => {
  const ok: ReviewFinding = { id: "ok", severity: "ok", title: "Eq. 3 matches the code", body: "It does.", refs: [{ paper: { page: 4, quote: "we select the best layer" } }], visuals: [] };
  renderPanel({ shown: { ...review, document: { ...review.document!, findings: [serious, minor, ok] }, dismissed: [{ id: "old", title: "Old finding", body: "", dismissedAt: "" }] } });
  expect(screen.getByText("The most serious problems Gali found. It may have missed others.")).toBeTruthy();
  expect(screen.getByText("Claims Gali checked against the PDF and code and found correct.")).toBeTruthy();
  expect(screen.getByText("Gali will not bring these up again.")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/reviewer/i);
});

test("practice problems show in full under To study, after the problems, and can be added to notes", () => {
  const ok: ReviewFinding = { id: "ok", severity: "ok", title: "Eq. 3 matches the code", body: "It does.", refs: [{ paper: { page: 4, quote: "we select the best layer" } }], visuals: [] };
  const study: ReviewFinding = {
    id: "practice",
    severity: "study",
    title: "Compute the group weights after one update",
    body: "Losses are 1 and 2. Solution: 0.475 and 0.525.",
    refs: [{ paper: { page: 4, quote: "we select the best layer" } }],
    visuals: [],
  };
  renderPanel({ shown: { ...review, document: { ...review.document!, findings: [study, serious, minor, ok] } } });
  const group = screen.getByRole("region", { name: "To study" });
  expect(within(group).getByText("Practice problems and worked examples Gali made from this PDF.")).toBeTruthy();
  const card = within(group).getByRole("heading", { name: study.title }).closest("article") as HTMLElement;
  expect(within(card).getByText("Study")).toBeTruthy();
  expect(within(card).getByText(study.body)).toBeTruthy();
  expect(within(card).getByRole("button", { name: "Add to notes" })).toBeTruthy();
  const groups = [...document.querySelectorAll(".review-group h2")].map((heading) => heading.textContent);
  expect(groups).toEqual(["Could change a conclusion", "Worth fixing", "What holds up", "To study"]);
  expect(screen.getByRole("region", { name: "Could change a conclusion" }).textContent).not.toContain(study.title);
});

test("math in a finding body is typeset, and a plain product stays plain text", () => {
  const study: ReviewFinding = {
    id: "math",
    severity: "study",
    title: "Work out L",
    body: "Backward: $\\partial L/\\partial e = c = -2$. Use q[g] * exp(eta_q * L[g]).",
    refs: [{ paper: { page: 4, quote: "we select the best layer" } }],
    visuals: [],
  };
  renderPanel({ shown: { ...review, document: { ...review.document!, findings: [study] } } });
  const body = document.querySelector("#review-math .review-finding-body") as HTMLElement;
  expect(body.querySelector(".katex")).toBeTruthy();
  expect(body.textContent).not.toContain("$");
  expect(body.textContent).toContain("Use q[g] * exp(eta_q * L[g]).");
  expect(body.querySelector("em")).toBeNull();
});

test("serious findings show in full; minor ones fold to their titles under their own count", () => {
  renderPanel();
  const serious = screen.getByRole("region", { name: "Could change a conclusion" });
  expect(within(serious).getByRole("heading", { name: "Layer selection reuses the evaluation labels" })).toBeTruthy();
  const minorGroup = screen.getByRole("region", { name: "Worth fixing" });
  expect(within(minorGroup).getByText("1 minor issue: wrong, but the conclusions stand.")).toBeTruthy();
  const folded = minorGroup.querySelector("details.review-minor") as HTMLDetailsElement;
  expect(folded.open).toBe(false);
  expect(folded.querySelector("summary")?.textContent).toBe(minor.title);
});

test("jumping to a minor finding unfolds it", () => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  render(
    <ReviewPanel
      projectKey="alpha"
      review={review}
      error=""
      notedFindings={new Set()}
      focusFinding={{ id: "variation", nonce: 1 }}
      onPaperRef={vi.fn()}
      onCodeRef={vi.fn()}
      onAddToNotes={vi.fn(async () => {})}
      onRemoveFromNotes={vi.fn(async () => {})}
      onDismiss={vi.fn(async () => {})}
      onRestore={vi.fn(async () => {})}
    />,
  );
  expect((document.querySelector("details.review-minor") as HTMLDetailsElement).open).toBe(true);
  expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
});

test("a finding's references and actions share one action bar under the text", () => {
  const { seriousCard } = renderPanel();
  const bar = seriousCard.querySelector(".review-finding-actions") as HTMLElement;
  expect(within(bar).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "p. 4",
    "process_clust.py:163–185",
    "Remove from notes",
    "Dismiss as not important",
  ]);
});

test("references open the paper page and the code lines", () => {
  const { props, seriousCard } = renderPanel();
  fireEvent.click(within(seriousCard).getByRole("button", { name: "p. 4" }));
  expect(props.onPaperRef).toHaveBeenCalledWith(4, anchor);
  fireEvent.click(within(seriousCard).getByRole("button", { name: "process_clust.py:163–185" }));
  expect(props.onCodeRef).toHaveBeenCalledWith("code/process_clust.py", [163, 185]);
});

test("passages on the same page share one chip that highlights them all", () => {
  const spread: ReviewFinding = {
    id: "spread",
    severity: "minor",
    title: "Claims spread over two pages",
    body: "Three passages.",
    refs: [
      { paper: { page: 5, quote: "first" } },
      { paper: { page: 3, quote: "second" } },
      { paper: { page: 3, quote: "third" } },
    ],
    visuals: [],
  };
  const rect = (x: number) => ({ x, y: 10, width: 20, height: 8 });
  const page3 = (x: number) => ({ page: 3, pageWidth: 612, pageHeight: 792, rects: [rect(x)] });
  const { props } = renderPanel({
    shown: {
      ...review,
      document: { title: "Correctness review", findings: [spread] },
      anchors: { "spread:0": { page: 5, pageWidth: 612, pageHeight: 792, rects: [rect(1)] }, "spread:1": page3(2), "spread:2": page3(3) },
    },
  });
  const card = screen.getByRole("heading", { name: spread.title }).closest("article") as HTMLElement;
  expect(within(card).getAllByRole("button", { name: /^p\. / }).map((button) => button.textContent)).toEqual(["p. 5", "p. 3"]);
  const chip = within(card).getByRole("button", { name: "p. 3" });
  expect(chip.getAttribute("title")).toBe("“second”\n“third”");
  fireEvent.click(chip);
  expect(props.onPaperRef).toHaveBeenCalledWith(3, { page: 3, pageWidth: 612, pageHeight: 792, rects: [rect(2), rect(3)] });
});

test("a named place leads the chip with the page beside it, one chip per place and page", () => {
  const placed: ReviewFinding = {
    id: "placed",
    severity: "minor",
    title: "Claims against the tables",
    body: "Three passages.",
    refs: [
      { paper: { page: 5, place: "Table 2", quote: "first" } },
      { paper: { page: 3, place: "§3.2 Clustering", quote: "second" } },
      { paper: { page: 3, place: "§3.2 Clustering", quote: "third" } },
      { paper: { page: 3, place: "§3.1 Data", quote: "fourth" } },
    ],
    visuals: [],
  };
  const at = (page: number) => ({ page, pageWidth: 612, pageHeight: 792, rects: [] });
  renderPanel({
    shown: {
      ...review,
      document: { title: "Correctness review", findings: [placed] },
      anchors: { "placed:0": at(5), "placed:1": at(3), "placed:2": at(3), "placed:3": at(3) },
    },
  });
  const card = screen.getByRole("heading", { name: placed.title }).closest("article") as HTMLElement;
  expect(within(card).getAllByRole("button").slice(0, 3).map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual([
    "Table 2 p. 5",
    "§3.2 Clustering p. 3",
    "§3.1 Data p. 3",
  ]);
  expect(within(card).getByRole("button", { name: "§3.2 Clustering p. 3" }).querySelector(".review-ref-page")?.textContent).toBe("p. 3");
});

test("a saved finding shows In notes and its button removes it", () => {
  const { props, seriousCard } = renderPanel();
  expect(within(seriousCard).getByText("In notes")).toBeTruthy();
  fireEvent.click(within(seriousCard).getByRole("button", { name: "Remove from notes" }));
  expect(props.onRemoveFromNotes).toHaveBeenCalledWith(serious);
});

test("an unsaved finding adds to notes", () => {
  const { props, minorCard } = renderPanel();
  fireEvent.click(within(minorCard).getByRole("button", { name: "Add to notes" }));
  expect(props.onAddToNotes).toHaveBeenCalledWith(minor);
});

test("a project with no PDF offers no Add to notes", () => {
  const { minorCard } = renderPanel({ canNote: false });
  expect(within(minorCard).queryByRole("button", { name: "Add to notes" })).toBeNull();
  expect(within(minorCard).getByRole("button", { name: "Dismiss as not important" })).toBeTruthy();
});

test("dismiss is an icon button named for what it does", () => {
  const { props, minorCard } = renderPanel();
  const dismiss = within(minorCard).getByRole("button", { name: "Dismiss as not important" });
  expect(dismiss.textContent).toBe("");
  fireEvent.click(dismiss);
  expect(props.onDismiss).toHaveBeenCalledWith(minor);
});

test("a figure drawn again shows the image already on screen at once, so the draft keeps its height", async () => {
  let made = 0;
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => `blob:${++made}`), revokeObjectURL: vi.fn() });
  const figure = <Figure projectKey="p" path="experiments/e1/a.png" caption="from e1" />;
  const first = render(figure);
  const img = await screen.findByRole("img", { name: "from e1" });
  expect(img.getAttribute("src")).toBe("blob:1");
  fireEvent.load(img);

  act(() => {
    for (const emit of api.projectEvents) emit({ projectKey: "p", seq: 1 });
  });
  await waitFor(() => expect(screen.getByRole("img", { name: "from e1" }).getAttribute("src")).toBe("blob:2"));
  first.unmount();

  render(figure);
  expect(screen.getByRole("img", { name: "from e1" }).getAttribute("src")).toBe("blob:1");
  expect(screen.queryByText("Loading…")).toBeNull();
  await waitFor(() => expect(screen.getByRole("img", { name: "from e1" }).getAttribute("src")).toBe("blob:2"));
  vi.unstubAllGlobals();
});
