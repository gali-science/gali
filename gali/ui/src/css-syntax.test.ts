/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Production concatenates every stylesheet, so one unclosed brace swallows all later CSS.
const root = join(process.cwd(), "src");
const sheets = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".css"));

it("finds the stylesheets", () => {
  expect(sheets).toContain(join("features", "guide", "guide.css"));
});

it.each(sheets)("%s has balanced braces", (file: string) => {
  const code = readFileSync(join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"[^"\n]*"/g, '""');
  let depth = 0;
  for (const char of code) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
});
