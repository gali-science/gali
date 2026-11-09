import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CodePreview } from "./CodePreview";

vi.mock("shiki", () => ({
  codeToHtml: async (code: string) =>
    `<pre><code>${code.split("\n").map((text, index) => `<span class="line" data-line="${index + 1}">${text}</span>`).join("\n")}</code></pre>`,
}));

const CODE = "a = 1\nb = a / alpha\nc = b.sum()\nreturn c";

function targets(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".is-target")).map((row) => row.dataset.line ?? "");
}

describe("CodePreview", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  test("keeps the cited lines marked when the preview re-renders", async () => {
    const lines: [number, number] = [2, 3];
    const { container, rerender } = render(
      <CodePreview path="code/dro.py" code={CODE} targetLines={lines} />,
    );
    await waitFor(() => expect(targets(container)).toEqual(["2", "3"]));

    rerender(<CodePreview path="code/dro.py" code={CODE} targetLines={lines} notice={<span>notice</span>} />);

    expect(targets(container)).toEqual(["2", "3"]);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });
});
