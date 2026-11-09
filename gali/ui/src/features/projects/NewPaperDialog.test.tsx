import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { NewPaperDialog } from "./NewPaperDialog";

const upload = vi.hoisted(() => vi.fn(async (input: { title: string }) => ({ key: "k", title: input.title })));
vi.mock("./import-upload", () => ({
  checkCodeZip: () => {},
  checkPaperFile: () => {},
  uploadPaperProject: upload,
}));

beforeEach(() => {
  upload.mockClear();
});

async function open(dialog: ReactElement) {
  render(dialog);
  await act(async () => {});
}

function pdf(name = "attention_is_all.pdf") {
  return new File(["%PDF-1.4\n"], name, { type: "application/pdf" });
}

function zip(name = "code.zip") {
  return new File(["PK"], name, { type: "application/zip" });
}

function fileInput(accept: string) {
  return document.querySelector(`input[type="file"][accept^="${accept}"]`) as HTMLInputElement;
}

function button(name: string | RegExp) {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

test("it only reviews a paper: no Start a project, name, or data", async () => {
  await open(<NewPaperDialog onClose={() => {}} onCreated={() => {}} />);
  expect(screen.queryByRole("group", { name: "What to add" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Start a project" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Choose data zip" })).toBeNull();
  expect(screen.getByRole("button", { name: "Choose PDF" })).toBeTruthy();
  expect(button("Add").disabled).toBe(true);
});

test("the dialog says PDF, never paper, so slides and notes fit too", async () => {
  await open(<NewPaperDialog onClose={() => {}} onCreated={() => {}} />);
  const labels = Array.from(document.querySelectorAll("[aria-label], [title], [placeholder]"))
    .flatMap((element) => ["aria-label", "title", "placeholder"].map((name) => element.getAttribute(name) ?? ""));
  expect([document.body.textContent, ...labels].join(" ")).not.toMatch(/paper/i);
});

test("a review needs the paper and takes the code as an optional link", async () => {
  const onCreated = vi.fn();
  await open(<NewPaperDialog onClose={() => {}} onCreated={onCreated} />);
  const start = button("Add");
  expect(start.disabled).toBe(true);

  fireEvent.change(fileInput(".pdf"), { target: { files: [pdf()] } });
  expect(screen.getByLabelText("PDF").textContent).toBe("attention_is_all.pdf");
  expect(start.disabled).toBe(false);

  fireEvent.click(button("Add code"));
  fireEvent.change(screen.getByRole("textbox", { name: "GitHub link" }), {
    target: { value: "https://github.com/owner/repo" },
  });
  await act(async () => {
    fireEvent.click(start);
  });
  const sent = upload.mock.calls[0]![0];
  expect(sent).toEqual(expect.objectContaining({
    title: "attention is all",
    codeUrl: "https://github.com/owner/repo",
  }));
  expect(sent).toHaveProperty("paper");
  expect(sent).not.toHaveProperty("question");
  expect(sent).not.toHaveProperty("data");
  expect(onCreated).toHaveBeenCalledOnce();
});

test("the PDF row says it is required until a PDF is chosen, even with code added", async () => {
  await open(<NewPaperDialog onClose={() => {}} onCreated={() => {}} />);
  fireEvent.drop(screen.getByRole("dialog", { name: "Add to library" }), {
    dataTransfer: { types: ["Files"], files: [zip("todo-bench-30.zip")] },
  });
  expect(button("Choose PDF").textContent).toContain("required");
  expect(button("Add").disabled).toBe(true);

  fireEvent.change(fileInput(".pdf"), { target: { files: [pdf()] } });
  expect(screen.queryByText("required")).toBeNull();
  expect(button("Add").disabled).toBe(false);
});

test("a long PDF file name becomes a short title", async () => {
  await open(<NewPaperDialog onClose={() => {}} onCreated={() => {}} />);
  fireEvent.change(fileInput(".pdf"), {
    target: { files: [pdf("ICLR-2026-ctc-dro-robust-optimization-for-reducing-language-disparities-in-speech-recognition-Paper-Conference (2).pdf")] },
  });
  await act(async () => {
    fireEvent.click(button("Add"));
  });
  expect(upload.mock.calls[0]![0]).toEqual(expect.objectContaining({
    title: "ICLR 2026 ctc dro robust optimization for reducing language",
  }));
});

test("a name Gali heard by voice becomes the title, and the paper is still needed", async () => {
  await open(<NewPaperDialog initialTitle="Attention" onClose={() => {}} onCreated={() => {}} />);
  expect(button("Add").disabled).toBe(true);
  fireEvent.change(fileInput(".pdf"), { target: { files: [pdf()] } });
  await act(async () => {
    fireEvent.click(button("Add"));
  });
  expect(upload.mock.calls[0]![0]).toEqual(expect.objectContaining({ title: "Attention" }));
});

test("a zip dropped on the dialog is the code", async () => {
  await open(<NewPaperDialog onClose={() => {}} onCreated={() => {}} />);
  fireEvent.drop(screen.getByRole("dialog", { name: "Add to library" }), {
    dataTransfer: { types: ["Files"], files: [zip("serving.zip")] },
  });
  expect(screen.getByLabelText("Code zip").textContent).toBe("serving.zip");
});

test("dropping a PDF fills in the paper", async () => {
  await open(<NewPaperDialog onClose={() => {}} onCreated={() => {}} />);
  const sheet = screen.getByRole("dialog", { name: "Add to library" });
  fireEvent.dragOver(sheet, { dataTransfer: { types: ["Files"], files: [] } });
  expect(screen.getByText("Drop to add")).toBeTruthy();

  fireEvent.drop(sheet, { dataTransfer: { types: ["Files"], files: [pdf("ctc-dro.pdf")] } });
  expect(screen.queryByText("Drop to add")).toBeNull();
  expect(screen.getByLabelText("PDF").textContent).toBe("ctc-dro.pdf");
  expect(button("Add").disabled).toBe(false);
});

test("the dialog says it is a research preview, and its terms open without closing it", async () => {
  const onClose = vi.fn();
  await open(<NewPaperDialog onClose={onClose} onCreated={() => {}} />);
  const sheet = screen.getByRole("dialog", { name: "Add to library" });
  expect(sheet.textContent).toContain("Research preview. Do not upload confidential information.");
  expect(sheet.textContent).toContain("By uploading, you agree to the Demo Terms and Privacy Notice.");

  await userEvent.click(button("Demo Terms"));
  expect(screen.getByRole("dialog", { name: "Gali Demo Terms" })).toBeTruthy();
  await userEvent.click(button("Close"));
  expect(screen.queryByRole("dialog", { name: "Gali Demo Terms" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Add to library" })).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});
