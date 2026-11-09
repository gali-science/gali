import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import type { NavEvent } from "../../api";
import { ProjectWorkspace } from "./ProjectWorkspace";

const nav = vi.hoisted(() => ({ listeners: new Set<(event: NavEvent) => void>() }));

vi.mock("../../api", () => ({
  cancelReview: vi.fn(async () => ({ cancelled: true })),
  createPdfAnnotation: vi.fn(),
  deletePdfAnnotation: vi.fn(),
  dismissFinding: vi.fn(),
  getProject: vi.fn(async () => ({ key: "alpha", title: "Alpha", paperPath: "paper.pdf", paperTitle: "Alpha" })),
  getReview: vi.fn(async () => null),
  getReviewProgress: vi.fn(async () => null),
  onNavEvent: (cb: (event: NavEvent) => void) => {
    nav.listeners.add(cb);
    return () => nav.listeners.delete(cb);
  },
  onProjectEvent: () => () => {},
  onReviewProgress: () => () => {},
  readPdfAnnotations: vi.fn(async () => []),
  restoreFinding: vi.fn(),
  setPdfAnnotationNote: vi.fn(),
}));
const shell = vi.hoisted(() => ({ phone: false }));
const papers = vi.hoisted(() => ({ shown: [] as string[] }));
vi.mock("../../hooks/use-phone-shell", () => ({ usePhoneShell: () => shell.phone }));
vi.mock("../../platform/runtime", () => ({ getPlatform: () => ({ capabilities: { downloadFiles: false } }) }));
vi.mock("./PaperViewer", () => ({
  PaperViewer: ({ projectKey, path }: { projectKey: string; path: string }) => {
    papers.shown.push(`${projectKey}/${path}`);
    return <div>paper</div>;
  },
}));
vi.mock("./ReviewPanel", () => ({ ReviewPanel: ({ canNote, agent }: { canNote: boolean; agent?: ReactNode }) => <div data-can-note={String(canNote)}>review{agent}</div>, findingNote: () => "", Figure: () => null, Visual: () => null }));
vi.mock("./NotesPanel", () => ({ NotesPanel: () => <div>notes</div> }));
vi.mock("./CodeWorkspace", () => ({ CodeWorkspace: () => <div>code</div> }));
vi.mock("./DeleteProjectDialog", () => ({ DeleteProjectDialog: () => null }));

afterEach(() => {
  shell.phone = false;
});

async function noPdfProject() {
  const api = await import("../../api");
  vi.mocked(api.getProject).mockResolvedValueOnce({ key: "alpha", title: "Alpha", paperPath: null, paperTitle: null, createdAt: "", updatedAt: "" });
}

function workspace(props: Partial<ComponentProps<typeof ProjectWorkspace>> = {}) {
  return (
    <ProjectWorkspace
      projectKey="alpha"
      refreshKey={0}
      navigationCommand={null}
      reviewerBusy={false}
      onGoHome={() => {}}
      onOpenAccount={() => {}}
      onDeleted={() => {}}
      chat={<div>chat</div>}
      bar={null}
      {...props}
    />
  );
}

async function renderWorkspace() {
  const view = render(workspace({ bar: <div data-testid="gali-bar" /> }));
  await act(async () => {});
  return view;
}

test("the Gali bar sits under the side panel card", async () => {
  const { container } = await renderWorkspace();
  const side = container.querySelector(".side-pane")!;
  expect(side.lastElementChild).toBe(screen.getByTestId("gali-bar"));
  expect(side.lastElementChild?.previousElementSibling?.className).toBe("side-tab-body");
  expect(container.querySelector(".review-panel.is-paper [data-testid='gali-bar']")).toBeNull();
});

test("the paper's More actions menu opens Account", async () => {
  const onOpenAccount = vi.fn();
  render(workspace({ onOpenAccount }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Browse code", "Account", "Delete"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Account" }));
  expect(onOpenAccount).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
});

test("a project without a paper offers no Add data, on desktop and phone", async () => {
  for (const phone of [false, true]) {
    shell.phone = phone;
    await noPdfProject();
    const view = render(workspace());
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(
      phone ? ["Browse code", "Delete"] : ["Browse code", "Account", "Delete"],
    );
    view.unmount();
  }
});

test("on a phone the header switch is the only one, while desktop keeps the side tabs", async () => {
  shell.phone = true;
  const phone = render(workspace());
  await act(async () => {});
  expect(Array.from(screen.getByRole("group", { name: "View" }).querySelectorAll("button")).map((button) => button.textContent))
    .toEqual(["PDF", "Findings", "Notes"]);
  fireEvent.click(screen.getByRole("button", { name: "Findings" }));
  expect(screen.getByRole("button", { name: "Findings" }).getAttribute("aria-pressed")).toBe("true");
  expect(phone.container.querySelector(".side-tab-body")).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  phone.unmount();

  shell.phone = false;
  render(workspace());
  await act(async () => {});
  expect(screen.getByRole("tablist", { name: "Findings, notes and chat" })).toBeTruthy();
  expect(screen.getByRole("tab", { name: /Findings/ })).toBeTruthy();
  expect(screen.queryByRole("group", { name: "View" })).toBeNull();
});

test("the splitter is a wide drag target, and an open HTML file can expand over the PDF and back", async () => {
  const view = render(workspace());
  await act(async () => {});
  const body = view.container.querySelector<HTMLElement>(".review-body")!;
  expect(body.style.gridTemplateColumns).toContain(" 9px ");
  expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
  body.getBoundingClientRect = () => ({ left: 0, width: 1000 }) as DOMRect;
  fireEvent.pointerDown(screen.getByRole("separator", { name: "Resize panels" }));
  fireEvent.pointerMove(window, { clientX: 50 });
  fireEvent.pointerUp(window);
  expect(body.style.gridTemplateColumns).toBe("minmax(0, 0.15fr) 9px minmax(0, 0.85fr)");

  view.rerender(workspace({ navigationCommand: { id: 1, projectKey: "alpha", type: "open-code-file", path: "review-icml.html" } }));
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  expect(body.className).toContain("is-wide");
  expect(body.style.gridTemplateColumns).toBe("minmax(0, 1fr)");

  fireEvent.click(screen.getByRole("button", { name: "Show PDF" }));
  expect(body.className).not.toContain("is-wide");

  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  view.rerender(workspace({ navigationCommand: { id: 2, projectKey: "alpha", type: "open-code-file", path: "code/train.py" } }));
  expect(screen.queryByRole("button", { name: "Expand" })).toBeNull();
  expect(body.className).not.toContain("is-wide");
  view.rerender(workspace({ navigationCommand: { id: 3, projectKey: "alpha", type: "open-code-file", path: "review-icml.html" } }));
  expect(body.className).not.toContain("is-wide");
});

test("the desktop breadcrumb leads back Home", async () => {
  const onGoHome = vi.fn();
  render(workspace({ onGoHome }));
  await act(async () => {});
  const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
  expect(crumbs.textContent).toBe("Home/");
  fireEvent.click(screen.getByRole("button", { name: "Home" }));
  expect(onGoHome).toHaveBeenCalledOnce();
});

test("the Chat tab carries no live dot", async () => {
  await renderWorkspace();
  expect(screen.getByRole("tab", { name: /Chat/ }).querySelector(".side-tab-live")).toBeNull();
});

test("while Gali works, the Findings tab keeps its dot whichever tab is open", async () => {
  const view = render(workspace({ reviewerBusy: true }));
  await act(async () => {});
  expect(screen.getByRole("tab", { name: /Findings.*working/ }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("tab", { name: /Notes/ }));
  expect(screen.getByRole("tab", { name: /Findings.*working/ })).toBeTruthy();
  view.rerender(workspace({ reviewerBusy: false }));
  expect(screen.getByRole("tab", { name: /Findings/ }).querySelector(".side-tab-live")).toBeNull();
});

test("while Gali works, the Findings tab shows its live row; when idle there is none", async () => {
  for (const phone of [false, true]) {
    shell.phone = phone;
    const view = render(workspace({ reviewerBusy: true }));
    await act(async () => {});
    if (phone) fireEvent.click(screen.getByRole("button", { name: "Findings" }));
    expect(screen.getByRole("status").textContent).toBe("Getting started");
    expect(screen.getByRole("img", { name: "Agent working" })).toBeTruthy();
    view.rerender(workspace({ reviewerBusy: false }));
    await act(async () => {});
    expect(screen.queryByRole("img", { name: "Agent working" })).toBeNull();
    view.unmount();
  }
});

test("a project with no PDF opens on its Findings, with no Lab, Agent, draft, or tabs menu", async () => {
  await noPdfProject();
  render(workspace({ reviewerBusy: true }));
  await act(async () => {});
  expect(screen.getByRole("tab", { name: /Findings/ }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByText("review")).toBeTruthy();
  expect(screen.queryByRole("tab", { name: /Lab|Agent/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "Show or hide tabs" })).toBeNull();
  expect(screen.queryByText("No draft yet")).toBeNull();
  expect(screen.queryByText("paper")).toBeNull();
});

test("a paper has a Notes tab and can note findings", async () => {
  await renderWorkspace();
  fireEvent.click(screen.getByRole("tab", { name: /Notes/ }));
  expect(screen.getByText("notes")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: /Findings/ }));
  expect(screen.getByText("review").getAttribute("data-can-note")).toBe("true");
});

test("a project with no PDF has no Notes tab, its Findings cannot be noted, and voice cannot open Notes", async () => {
  await noPdfProject();
  const view = render(workspace());
  await act(async () => {});
  expect(screen.queryByRole("tab", { name: /Notes/ })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: /Findings/ }));
  expect(screen.getByText("review").getAttribute("data-can-note")).toBe("false");
  view.rerender(workspace({ navigationCommand: { id: 1, projectKey: "alpha", type: "show-tab", tab: "notes" } }));
  expect(screen.queryByText("notes")).toBeNull();
  expect(screen.getByRole("tab", { name: /Findings/ }).getAttribute("aria-selected")).toBe("true");
});

test("a voice notes change on this paper refetches its notes; one on another paper does not", async () => {
  const api = await import("../../api");
  await renderWorkspace();
  const reads = vi.mocked(api.readPdfAnnotations).mock.calls.length;
  await act(async () => {
    for (const listener of nav.listeners) listener({ type: "pdf_annotations_changed", projectKey: "beta" });
  });
  expect(vi.mocked(api.readPdfAnnotations).mock.calls.length).toBe(reads);
  await act(async () => {
    for (const listener of nav.listeners) listener({ type: "pdf_annotations_changed", projectKey: "alpha" });
  });
  expect(vi.mocked(api.readPdfAnnotations).mock.calls.length).toBe(reads + 1);
});

test("switching projects never shows the new project with the old project's PDF", async () => {
  const api = await import("../../api");
  const view = await renderWorkspace();
  let loadBeta: (project: Awaited<ReturnType<typeof api.getProject>>) => void = () => {};
  vi.mocked(api.getProject).mockImplementationOnce(() => new Promise((resolve) => { loadBeta = resolve; }));
  papers.shown = [];

  view.rerender(workspace({ projectKey: "beta" }));
  await act(async () => {});
  expect(screen.getByText("loading…")).toBeTruthy();
  await act(async () => {
    loadBeta({ key: "beta", title: "Beta", paperPath: "paper/beta.pdf", paperTitle: "Beta", createdAt: "", updatedAt: "" });
  });

  expect(papers.shown.length).toBeGreaterThan(0);
  expect(new Set(papers.shown)).toEqual(new Set(["beta/paper/beta.pdf"]));
});
