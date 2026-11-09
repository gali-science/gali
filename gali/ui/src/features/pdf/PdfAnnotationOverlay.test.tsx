import { fireEvent, render } from "@testing-library/react";
import { expect, test } from "vitest";
import type { PdfAnnotationDto } from "../../api";
import { PdfAnnotationOverlay } from "./PdfAnnotationOverlay";

const base = { pageWidth: 600, pageHeight: 800, quote: null, note: null, color: "yellow", createdAt: "" } as const;
const annotations: PdfAnnotationDto[] = [
  { ...base, number: 1, page: 2, rects: [{ x: 60, y: 200, width: 300, height: 10 }], quote: "a line", color: "green" },
  { ...base, number: 2, page: 2, rects: [], note: "Method starts here." },
  { ...base, number: 3, page: 5, rects: [{ x: 0, y: 0, width: 10, height: 10 }] },
];

test("draws this page's highlights in page percentages and pins notes", () => {
  const { container } = render(<PdfAnnotationOverlay pageNumber={2} annotations={annotations} />);

  const marks = container.querySelectorAll<HTMLElement>(".pdf-annotation-mark");
  expect(marks).toHaveLength(1);
  expect(marks[0]!.style.left).toBe("10%");
  expect(marks[0]!.style.top).toBe("25%");
  expect(marks[0]!.style.width).toBe("50%");
  expect(container.querySelector<HTMLElement>(".pdf-annotation")!.style.getPropertyValue("--annotation-rgb"))
    .toBe("52 199 89");

  const pins = [...container.querySelectorAll<HTMLElement>(".pdf-annotation-pin")];
  expect(pins.map((pin) => pin.textContent)).toEqual(["1", "2"]);
  expect(pins[0]!.closest<HTMLElement>(".pdf-annotation-anchor")!.style.left).toBe("60%");
  expect(pins[1]!.classList.contains("has-note")).toBe(true);
});

test("a note pin opens and closes its note on click", () => {
  const view = render(<PdfAnnotationOverlay pageNumber={2} annotations={annotations} />);
  const pin = view.getByRole("button", { name: "Note 2" });
  const note = view.getByRole("note");
  expect(note.textContent).toBe("2Method starts here.");
  expect(pin.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(pin);
  expect(pin.getAttribute("aria-expanded")).toBe("true");
  expect(note.closest(".pdf-annotation")!.classList.contains("is-open")).toBe(true);

  fireEvent.click(pin);
  expect(note.closest(".pdf-annotation")!.classList.contains("is-open")).toBe(false);
  expect(view.getByRole("button", { name: "Highlight 1" }).getAttribute("aria-expanded")).toBeNull();
});

test("renders nothing on a page without annotations", () => {
  const { container } = render(<PdfAnnotationOverlay pageNumber={3} annotations={annotations} />);
  expect(container.innerHTML).toBe("");
});
