import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SourceFileViewer } from "./SourceFileViewer";

const api = vi.hoisted(() => ({
  readProjectFile: vi.fn(),
  readProjectMedia: vi.fn(),
}));

vi.mock("../../api", () => api);
vi.mock("./CodePreview", () => ({
  CodePreview: ({ code, notice }: { code: string; notice?: React.ReactNode }) => (
    <div>
      {notice}
      <pre>{code}</pre>
    </div>
  ),
}));
vi.mock("./PdfPreview", () => ({
  // PDFs render from bytes now, so the byte count is what proves they arrived.
  PdfPreview: ({ data, identity }: { data: ArrayBuffer; identity: string }) => (
    <div data-testid="pdf-preview">{`${identity}:${data.byteLength}`}</div>
  ),
}));
vi.mock("../../Markdown", () => ({
  Markdown: ({ children, notes }: { children: string; notes?: boolean }) => (
    <div data-testid="md">{notes ? "Notes " : ""}{children.replace(/^#+\s*/gm, "")}</div>
  ),
}));

describe("SourceFileViewer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:mock"),
      revokeObjectURL: vi.fn(),
    });
  });

  test("renders text files through the code preview", async () => {
    api.readProjectFile.mockResolvedValue({
      file: { path: "main.py", kind: "text", binary: false, bytes: 12 },
      content: "print('hi')",
    });
    render(<SourceFileViewer projectKey="demo" path="main.py" />);
    expect(await screen.findByText("print('hi')")).toBeDefined();
  });

  test("renders truncated text with a notice above the content", async () => {
    api.readProjectFile.mockResolvedValue({
      file: { path: "run.log", kind: "text", binary: false, bytes: 500_000 },
      content: "line one\nline two",
      truncated: true,
      nextOffset: 17,
    });

    render(<SourceFileViewer projectKey="demo" path="run.log" />);

    expect(await screen.findByText(/Showing the first part of this file/)).toBeDefined();
    expect(screen.getByText(/line one/)).toBeDefined();
  });

  test("Load more appends the next chunk and clears the notice at the end", async () => {
    api.readProjectFile.mockResolvedValueOnce({
      file: { path: "run.log", kind: "text", binary: false, bytes: 500_000 },
      content: "first chunk\n",
      truncated: true,
      nextOffset: 12,
    });
    api.readProjectFile.mockResolvedValueOnce({
      file: { path: "run.log", kind: "text", binary: false, bytes: 500_000 },
      content: "second chunk",
    });

    render(<SourceFileViewer projectKey="demo" path="run.log" />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));

    await waitFor(() => {
      expect(screen.getByText(/first chunk\s*second chunk/)).toBeDefined();
    });
    expect(api.readProjectFile).toHaveBeenLastCalledWith("demo", "run.log", 12);
    expect(screen.queryByText(/Showing the first part of this file/)).toBeNull();
  });

  test("shows the too-large notice for a truncated svg instead of a broken image", async () => {
    api.readProjectFile.mockResolvedValue({
      file: { path: "big.svg", kind: "image", binary: false, bytes: 500_000 },
      content: "<svg xmlns='http://www.w3.org/2000/svg'",
      truncated: true,
    });

    render(<SourceFileViewer projectKey="demo" path="big.svg" />);

    expect(await screen.findByText(/too large to preview/)).toBeDefined();
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("renders svg files as images, not as XML source", async () => {
    api.readProjectFile.mockResolvedValue({
      file: { path: "plot.svg", kind: "image", binary: false, bytes: 120 },
      content: "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    });

    render(<SourceFileViewer projectKey="demo" path="plot.svg" />);

    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("blob:mock");
    expect(screen.queryByText(/svg xmlns/)).toBeNull();
  });

  test("renders images through the media endpoint", async () => {
    api.readProjectFile.mockRejectedValue(
      new Error("GET /projects/demo/source/read -> 500: binary image files cannot be read"),
    );
    api.readProjectMedia.mockResolvedValue({
      path: "dtw plot.jpg",
      kind: "image",
      mime: "image/jpeg",
      data: new Uint8Array([1, 2, 3]),
    });

    render(<SourceFileViewer projectKey="demo" path="dtw plot.jpg" />);

    const image = await screen.findByRole("img");
    expect(image.getAttribute("src")).toBe("blob:mock");
    expect(api.readProjectMedia).toHaveBeenCalledWith("demo", "dtw plot.jpg");
    expect(screen.queryByText(/No preview for this format/)).toBeNull();
  });

  test("shows the too-large message when media exceeds the display limit", async () => {
    api.readProjectFile.mockRejectedValue(
      new Error("500: binary image files cannot be read"),
    );
    api.readProjectMedia.mockRejectedValue(
      new Error("media exceeds display limit of 26214400 bytes"),
    );

    render(<SourceFileViewer projectKey="demo" path="huge.png" />);

    expect(await screen.findByText(/too large to preview/)).toBeDefined();
  });

  test("falls back to the binary message when media cannot be displayed", async () => {
    api.readProjectFile.mockRejectedValue(
      new Error("500: binary image files cannot be read"),
    );
    api.readProjectMedia.mockRejectedValue(
      new Error("media format cannot be displayed: .heic"),
    );

    render(<SourceFileViewer projectKey="demo" path="photo.heic" />);

    expect(await screen.findByText(/No preview for this format/)).toBeDefined();
  });

  test("shows the no-preview notice for binary data without the text read, whose refusal arrives redacted", async () => {
    api.readProjectFile.mockRejectedValue(
      new Error("GET /projects/demo/source/read -> 500: internal server error"),
    );

    render(<SourceFileViewer projectKey="demo" path="artifacts/librispeech_dummy_dutch.parquet" />);

    expect(await screen.findByText("No preview for this format.")).toBeDefined();
    expect(api.readProjectFile).not.toHaveBeenCalled();
    expect(screen.queryByText(/internal server error/)).toBeNull();
  });

  test("renders PDFs through the media endpoint", async () => {
    api.readProjectFile.mockRejectedValue(
      new Error("GET /projects/demo/source/read -> 500: binary pdf files cannot be read"),
    );
    api.readProjectMedia.mockResolvedValue({
      path: "paper.pdf",
      kind: "pdf",
      mime: "application/pdf",
      data: new Uint8Array([37, 80, 68, 70]),
    });

    render(<SourceFileViewer projectKey="demo" path="paper.pdf" />);

    const preview = await screen.findByTestId("pdf-preview");
    expect(preview.textContent).toBe("paper.pdf:4");
    expect(api.readProjectMedia).toHaveBeenCalledWith("demo", "paper.pdf");
    expect(screen.queryByText(/No preview for this format/)).toBeNull();
  });

  test("renders html files as a sandboxed page, not source", async () => {
    const html = "<!DOCTYPE html><html><body><h1>Best footballers</h1><table><tr><td>Messi</td></tr></table></body></html>";
    api.readProjectFile.mockResolvedValue({
      file: { path: "figures/xi.html", kind: "text", binary: false, bytes: html.length },
      content: html,
    });

    const { container } = render(<SourceFileViewer projectKey="demo" path="figures/xi.html" />);
    const frame = await waitFor(() => {
      const node = container.querySelector("iframe");
      if (!node) throw new Error("iframe missing");
      return node;
    });
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toBe(html);
    expect(screen.queryByText(html)).toBeNull();
  });

  test("renders markdown files as prose, not code", async () => {
    api.readProjectFile.mockResolvedValue({
      file: { path: "notes.md", kind: "text", binary: false, bytes: 20 },
      content: "## Hello\n\nSummary body.",
    });
    render(<SourceFileViewer projectKey="demo" path="notes.md" />);
    expect(await screen.findByText(/Hello/)).toBeDefined();
    expect(screen.getByText(/Notes /)).toBeDefined();
    expect(screen.queryByText("## Hello")).toBeNull();
  });

  test("does not stay on Loading after an empty markdown file arrives", async () => {
    api.readProjectFile.mockResolvedValue({
      file: { path: "empty.md", kind: "text", binary: false, bytes: 0 },
      content: "",
    });
    render(<SourceFileViewer projectKey="demo" path="empty.md" />);
    expect(await screen.findByText("Notes")).toBeDefined();
    expect(screen.queryByText("Loading…")).toBeNull();
  });
});
