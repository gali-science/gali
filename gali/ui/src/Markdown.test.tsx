import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Markdown } from "./Markdown";

test("renders inline code", () => {
  const { container } = render(<Markdown>{"use `foo` now"}</Markdown>);
  expect(container.querySelector("code")?.textContent).toBe("foo");
});

test("renders fenced code blocks", () => {
  const { container } = render(<Markdown>{"```\nconst x = 1;\n```"}</Markdown>);
  expect(container.querySelector("pre code")?.textContent).toContain("const x = 1;");
});

test("renders gfm tables", () => {
  const { container } = render(<Markdown>{"| a | b |\n| - | - |\n| 1 | 2 |"}</Markdown>);
  expect(container.querySelector("table")).not.toBeNull();
});

test("does not instantiate raw html", () => {
  const { container } = render(
    <Markdown>{'before <img src="x" onerror="window.close()"> after'}</Markdown>,
  );
  expect(container.querySelector("img")).toBeNull();
});

test("links open in a new tab", () => {
  const { container } = render(<Markdown>{"[docs](https://example.com)"}</Markdown>);
  const anchor = container.querySelector("a");
  expect(anchor?.getAttribute("href")).toBe("https://example.com");
  expect(anchor?.getAttribute("target")).toBe("_blank");
  expect(anchor?.getAttribute("rel")).toBe("noreferrer");
});

test("renders markdown images as links", () => {
  const { container } = render(<Markdown>{"![plot](https://example.com/p.png)"}</Markdown>);
  expect(container.querySelector("img")).toBeNull();
  const anchor = container.querySelector("a");
  expect(anchor?.getAttribute("href")).toBe("https://example.com/p.png");
  expect(anchor?.textContent).toBe("plot");
});

test("renders inline LaTeX with KaTeX", () => {
  const { container } = render(<Markdown>{"bound $\\lambda_{\\min}^+(A) \\ge 0$ holds"}</Markdown>);
  expect(container.querySelector(".katex")).not.toBeNull();
  expect(container.textContent).toContain("bound");
  expect(container.textContent).toContain("holds");
});

test("renders display LaTeX with KaTeX", () => {
  const { container } = render(
    <Markdown>{
      ["See", "", "$$", "P(s_{\\min}(G) \\le \\sqrt{m}-\\sqrt{n}-t) \\le e^{-t^2/2}", "$$", "", "ok"].join("\n")
    }</Markdown>,
  );
  expect(container.querySelector(".katex-display")).not.toBeNull();
  expect(container.querySelector(".katex")).not.toBeNull();
});

test("empty notes say the file has no text", () => {
  const { container } = render(<Markdown notes math={false}>{""}</Markdown>);
  expect(container.querySelector(".notes-md-empty")?.textContent).toMatch(/empty/i);
});

test("notes skin adds the notes-md class", () => {
  const { container } = render(<Markdown notes math={false}>{"# Title\n\nLead paragraph."}</Markdown>);
  expect(container.querySelector(".notes-md")).not.toBeNull();
  expect(container.querySelector("h1")?.textContent).toBe("Title");
});
