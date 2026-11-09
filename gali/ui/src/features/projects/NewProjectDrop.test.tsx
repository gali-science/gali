import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { NewProjectDrop } from "./NewProjectDrop";

vi.mock("./import-upload", () => ({
  checkCodeZip: () => {},
  checkPaperFile: () => {},
  uploadPaperProject: vi.fn(),
}));

test("the drop page says it is a research preview and links the terms once", async () => {
  render(<NewProjectDrop onCreated={() => {}} onChooseFiles={() => {}} />);
  const page = screen.getByRole("region", { name: "New project" });
  expect(page.textContent).toContain("Research preview. Do not upload confidential information.");
  expect(page.textContent).toContain("By uploading, you agree to the Demo Terms and Privacy Notice.");
  expect(screen.getAllByRole("button", { name: /terms/i }).map((link) => link.textContent)).toEqual(["Demo Terms"]);
  expect(screen.getAllByRole("button", { name: /privacy/i }).map((link) => link.textContent)).toEqual(["Privacy Notice"]);

  await userEvent.click(screen.getByRole("button", { name: "Privacy Notice" }));
  expect(screen.getByRole("dialog", { name: "Privacy Notice" }).closest("p")).toBeNull();
});
