import { expect, test } from "vitest";
import { languageFromPath } from "./language-from-path";

test("languageFromPath maps common source extensions", () => {
  expect(languageFromPath("extract_features.py")).toBe("python");
  expect(languageFromPath("src/app.tsx")).toBe("tsx");
  expect(languageFromPath("notes/readme.md")).toBe("markdown");
  expect(languageFromPath("unknown.xyz")).toBe("plaintext");
});
