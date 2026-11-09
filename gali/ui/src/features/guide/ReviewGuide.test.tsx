import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReviewGuide } from "./ReviewGuide";

describe("ReviewGuide", () => {
  it("switches between the glance and the full guide", () => {
    render(<ReviewGuide onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Reviewing a paper with AI" });
    expect(dialog.className).toBe("rg");

    fireEvent.click(screen.getByRole("button", { name: "Read the full guide" }));
    expect(dialog.className).toBe("rg is-reading");

    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(dialog.className).toBe("rg");
  });

  it("closes from Got it, the close button and Escape", () => {
    const onClose = vi.fn();
    render(<ReviewGuide onClose={onClose} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Got it" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
