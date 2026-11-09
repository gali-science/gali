import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectDto } from "../../api";
import { DeleteProjectDialog } from "./DeleteProjectDialog";

const api = vi.hoisted(() => ({
  deleteProject: vi.fn(),
}));

vi.mock("../../api", () => api);

const project: ProjectDto = {
  key: "disposable-arena",
  title: "Disposable Arena",
  paperPath: "paper/arena.pdf",
  paperTitle: null,
  createdAt: "2026-07-20T00:00:00.000Z",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

describe("DeleteProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("requires the exact title before deleting", async () => {
    const user = userEvent.setup();
    api.deleteProject.mockResolvedValue({ deleted: true, projectKey: project.key, title: project.title });
    const onDeleted = vi.fn();

    render(<DeleteProjectDialog project={project} onClose={vi.fn()} onDeleted={onDeleted} />);

    const deleteButton = screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(deleteButton.disabled).toBe(true);
    expect(screen.getByRole("dialog", { name: "Delete" }).textContent).not.toMatch(/paper/i);

    await user.type(screen.getByPlaceholderText("Disposable Arena"), "Disposable Arena");
    expect(deleteButton.disabled).toBe(false);
    await user.click(deleteButton);

    await waitFor(() => {
      expect(api.deleteProject).toHaveBeenCalledWith("disposable-arena", "Disposable Arena");
    });
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  test("shows the error when deleting fails", async () => {
    const user = userEvent.setup();
    api.deleteProject.mockRejectedValue(new Error("disk is read-only"));

    render(<DeleteProjectDialog project={project} onClose={vi.fn()} onDeleted={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Disposable Arena"), "Disposable Arena");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("Couldn’t delete")).toBeTruthy();
    expect(screen.getByText("disk is read-only")).toBeTruthy();
  });
});
