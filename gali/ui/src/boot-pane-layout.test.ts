import { afterEach, expect, test } from "vitest";
import css from "./styles.css?raw";

afterEach(() => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

function positionOf(html: string, selector: string): string {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = html;
  return getComputedStyle(document.querySelector(selector)!).position;
}

test.each([
  ["boot", `<section class="roster-pane is-empty boot-pane"></section>`],
  ["sign-in", `<section class="roster-pane is-empty boot-pane login-pane"></section>`],
])("the %s screen covers the whole window", (_name, html) => {
  expect(positionOf(html, ".boot-pane")).toBe("fixed");
});

test("the empty Home anchors its corner Account button", () => {
  expect(positionOf(
    `<section class="roster-pane is-empty"><button class="home-account is-corner"></button></section>`,
    ".roster-pane",
  )).toBe("relative");
});
