import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProjectDto } from "../api";
import { DesktopProjectsRoster, MobileProjectsRoster } from "./project-rosters";

function paper(key: string, title: string, updatedAt: string): ProjectDto {
  return { key, title, paperPath: `paper/${key}.pdf`, paperTitle: null, createdAt: updatedAt, updatedAt };
}

const older = paper("old-paper", "Old Paper", "2026-10-01T00:00:00.000Z");
const newer = paper("new-paper", "New Paper", "2026-10-02T00:00:00.000Z");

describe("papers roster", () => {
  afterEach(() => cleanup());

  test("desktop leads with the most recent paper and its file name", () => {
    const onOpen = vi.fn();
    render(<DesktopProjectsRoster projects={[older, newer]} onOpen={onOpen} onNewPaper={vi.fn()} onOpenAccount={vi.fn()} />);
    expect(screen.getByText("new-paper.pdf")).toBeTruthy();
    fireEvent.click(screen.getByText("New Paper"));
    expect(onOpen).toHaveBeenCalledWith("new-paper");
  });

  test("desktop puts an icon-only Add to library and Account beside the Library title", () => {
    const onNewPaper = vi.fn();
    const onOpenAccount = vi.fn();
    render(<DesktopProjectsRoster projects={[older, newer]} onOpen={vi.fn()} onNewPaper={onNewPaper} onOpenAccount={onOpenAccount} />);
    const header = screen.getByRole("heading", { name: "Library" }).parentElement!;
    const newPaper = within(header).getByRole("button", { name: "Add to library" });
    expect(newPaper.textContent).toBe("");
    fireEvent.click(newPaper);
    fireEvent.click(within(header).getByRole("button", { name: "Account" }));
    expect(onNewPaper).toHaveBeenCalledOnce();
    expect(onOpenAccount).toHaveBeenCalledOnce();
  });

  test("desktop empty state offers Add to library and Account", () => {
    const onNewPaper = vi.fn();
    const onOpenAccount = vi.fn();
    render(<DesktopProjectsRoster projects={[]} onOpen={vi.fn()} onNewPaper={onNewPaper} onOpenAccount={onOpenAccount} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to library" }));
    fireEvent.click(screen.getByRole("button", { name: "Account" }));
    expect(onNewPaper).toHaveBeenCalledOnce();
    expect(onOpenAccount).toHaveBeenCalledOnce();
  });

  test("phone lists every paper newest first", () => {
    render(
      <MobileProjectsRoster
        projects={[older, newer]}
        onOpen={vi.fn()}
        onNewPaper={vi.fn()}
        onOpenAccount={vi.fn()}
      />,
    );
    const titles = [...document.querySelectorAll(".mobile-home-row-title")].map((node) => node.textContent);
    expect(titles).toEqual(["New Paper", "Old Paper"]);
  });

  test("phone empty state keeps More actions out of the centered block and opens Account", () => {
    const onOpenAccount = vi.fn();
    render(<MobileProjectsRoster projects={[]} onOpen={vi.fn()} onNewPaper={vi.fn()} onOpenAccount={onOpenAccount} />);
    const menu = screen.getByRole("button", { name: "More actions" });
    expect(menu.closest(".mobile-home-empty")).toBeNull();
    expect(menu.parentElement!.classList.contains("home-book")).toBe(true);
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole("menuitem", { name: "Account" }));
    expect(onOpenAccount).toHaveBeenCalledOnce();
  });
});
