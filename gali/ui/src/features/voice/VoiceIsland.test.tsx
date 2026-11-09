import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { VoiceIsland } from "./VoiceIsland";

vi.mock("./PillOrb", () => ({
  PillOrb: () => <canvas data-testid="pill-orb" className="pill-orb-canvas" />,
}));

const base = {
  connecting: false,
  muted: false,
  error: null as string | null,
  inputLevel: 0,
  outputLevel: 0,
  toolPulse: 0,
  onToggle: vi.fn(),
  onMute: vi.fn(),
  onClearError: vi.fn(),
};

describe("VoiceIsland", () => {
  test("keeps mute/end controls while waiting on a tool", () => {
    vi.useFakeTimers();
    try {
      render(<VoiceIsland {...base} connected pendingTool="ask_reviewer" />);
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(screen.getByTitle("Mute mic (Ctrl+M)")).toBeTruthy();
      expect(screen.getByTitle("End voice (Ctrl+Space)")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  test("drops Muted immediately on unmute", () => {
    const { rerender, container } = render(
      <VoiceIsland {...base} connected muted />,
    );
    expect(container.querySelector(".voice-island-state")?.textContent).toBe("Muted");

    rerender(<VoiceIsland {...base} connected muted={false} />);
    expect(container.querySelector(".voice-island-state")?.textContent).toBe("Ready");
    expect(container.querySelector(".voice-island")?.getAttribute("data-phase")).toBe("idle");
  });

  test("keeps mute control when muted and waiting on a tool", () => {
    vi.useFakeTimers();
    try {
      render(<VoiceIsland {...base} connected muted pendingTool="ask_reviewer" />);
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(screen.getByRole("status").textContent).toContain("Looking into it");
      expect(screen.getByRole("status").textContent).not.toContain("Muted");
      expect(screen.getByTitle("Unmute mic (Ctrl+M)")).toBeTruthy();
      expect(screen.getByTitle("End voice (Ctrl+Space)")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  describe("waiting chip for in-flight tools", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    test("shows after the delay while a slow tool runs, hides when it finishes", () => {
      vi.useFakeTimers();
      const { container, rerender } = render(
        <VoiceIsland {...base} connected pendingTool="ask_reviewer" />,
      );
      expect(screen.queryByRole("status")).toBeNull();

      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(screen.getByRole("status").textContent).toContain("Looking into it");
      expect(container.querySelector(".voice-island")?.getAttribute("data-phase")).toBe("wait");
      expect(container.querySelector(".voice-island")?.getAttribute("data-wait")).toBe("on");

      rerender(<VoiceIsland {...base} connected pendingTool={null} />);
      expect(screen.queryByRole("status")).toBeNull();
    });

    test("never appears for tools that finish before the delay", () => {
      vi.useFakeTimers();
      const { rerender } = render(
        <VoiceIsland {...base} connected pendingTool="open_project" />,
      );
      act(() => {
        vi.advanceTimersByTime(300);
      });
      rerender(<VoiceIsland {...base} connected pendingTool={null} />);
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(screen.queryByRole("status")).toBeNull();
    });

    test("falls back to a generic label", () => {
      vi.useFakeTimers();
      render(
        <VoiceIsland {...base} connected pendingTool="mystery_tool" />,
      );
      act(() => {
        vi.advanceTimersByTime(700);
      });
      expect(screen.getByRole("status").textContent).toContain("Working on it");
    });
  });

  describe("docked with a text field", () => {
    test("idle shows the text field and play; typing swaps play for send", async () => {
      const onSend = vi.fn(async () => {});
      const onToggle = vi.fn();
      const { container } = render(
        <VoiceIsland {...base} connected={false} onToggle={onToggle} onSend={onSend} />,
      );
      expect(container.querySelector(".voice-island.is-docked")).not.toBeNull();
      const input = screen.getByPlaceholderText("Ask Gali about this PDF…") as HTMLInputElement;
      expect(screen.getByTitle("Start voice (Ctrl+Space)")).toBeTruthy();
      expect(screen.queryByTitle("Send")).toBeNull();

      fireEvent.change(input, { target: { value: "  what data do they use?  " } });
      expect(screen.queryByTitle("Start voice (Ctrl+Space)")).toBeNull();
      await act(async () => {
        fireEvent.click(screen.getByTitle("Send"));
      });
      expect(onSend).toHaveBeenCalledWith("what data do they use?");
      expect(onToggle).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    });

    test("keeps the text when sending fails", async () => {
      const onSend = vi.fn(async () => {
        throw new Error("offline");
      });
      render(<VoiceIsland {...base} connected={false} onSend={onSend} />);
      const input = screen.getByPlaceholderText("Ask Gali about this PDF…") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "hello" } });
      await act(async () => {
        fireEvent.submit(input.closest("form")!);
      });
      expect(input.value).toBe("hello");
    });

    test("live voice keeps the text field next to the state, mute and end", () => {
      const { container } = render(
        <VoiceIsland {...base} connected onSend={vi.fn(async () => {})} />,
      );
      expect(screen.getByPlaceholderText("Ask Gali about this PDF…")).toBeTruthy();
      expect(container.querySelector(".voice-island-state")?.textContent).toBe("Ready");
      expect(screen.getByTitle("Mute mic (Ctrl+M)")).toBeTruthy();
      expect(screen.getByTitle("End voice (Ctrl+Space)")).toBeTruthy();
      expect(screen.queryByTitle("Send")).toBeNull();
    });

    test("connecting keeps the text field, so the state sits where it stays once live", () => {
      const onSend = vi.fn(async () => {});
      const { container, rerender } = render(
        <VoiceIsland {...base} connected={false} onSend={onSend} />,
      );
      rerender(<VoiceIsland {...base} connected={false} connecting onSend={onSend} />);
      const input = screen.getByPlaceholderText("Ask Gali about this PDF…");
      expect(input.nextElementSibling?.className).toBe("voice-island-state");
      expect(container.querySelector(".voice-island-state")?.textContent).toBe("Connecting");
      expect(container.querySelectorAll(".voice-island-controls .voice-island-ctl")).toHaveLength(2);
      expect((screen.getByTitle("Mute mic (Ctrl+M)") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTitle("Connecting") as HTMLButtonElement).disabled).toBe(true);
      fireEvent.change(input, { target: { value: "and figure 2?" } });
      fireEvent.submit(input.closest("form")!);
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.queryByTitle("Send")).toBeNull();
    });

    test("typing while live hides the state word for room, adds send and keeps mute and end", async () => {
      const onSend = vi.fn(async () => {});
      const onToggle = vi.fn();
      const { container } = render(<VoiceIsland {...base} connected onToggle={onToggle} onSend={onSend} />);
      const input = screen.getByPlaceholderText("Ask Gali about this PDF…") as HTMLInputElement;
      expect(container.querySelector(".voice-island-state")).toBeTruthy();
      fireEvent.change(input, { target: { value: "and figure 2?" } });
      expect(container.querySelector(".voice-island-state")).toBeNull();
      expect(screen.getByTitle("Mute mic (Ctrl+M)")).toBeTruthy();
      expect(screen.getByTitle("End voice (Ctrl+Space)")).toBeTruthy();
      await act(async () => {
        fireEvent.click(screen.getByTitle("Send"));
      });
      expect(onSend).toHaveBeenCalledWith("and figure 2?");
      expect(onToggle).not.toHaveBeenCalled();
      expect(input.value).toBe("");
    });

    test("never collapses while idle", () => {
      vi.useFakeTimers();
      try {
        const { container } = render(
          <VoiceIsland {...base} connected={false} onSend={vi.fn(async () => {})} />,
        );
        act(() => {
          vi.advanceTimersByTime(5_000);
        });
        expect(container.querySelector(".voice-island")?.getAttribute("data-size")).toBe("full");
      } finally {
        vi.useRealTimers();
      }
    });

    test("Look sits in the bar, idle or live, and can be turned off", () => {
      const onLook = vi.fn();
      const { rerender } = render(
        <VoiceIsland {...base} connected={false} onSend={vi.fn(async () => {})} onLook={onLook} lookDisabled={false} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Look" }));
      expect(onLook).toHaveBeenCalledOnce();

      rerender(<VoiceIsland {...base} connected onSend={vi.fn(async () => {})} onLook={onLook} lookDisabled={false} />);
      expect(screen.getByRole("button", { name: "Look" })).toBeTruthy();
      expect(screen.getByTitle("End voice (Ctrl+Space)")).toBeTruthy();

      rerender(<VoiceIsland {...base} connected onSend={vi.fn(async () => {})} onLook={onLook} lookDisabled />);
      expect((screen.getByRole("button", { name: "Look" }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  test("the floating pill has no Look button", () => {
    render(<VoiceIsland {...base} connected={false} />);
    expect(screen.queryByRole("button", { name: "Look" })).toBeNull();
  });
});
