import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { DemoTermsLink, PrivacyLink } from "./DemoTerms";

afterEach(() => {
  cleanup();
});

test("the Demo Terms link opens and closes the terms", async () => {
  render(<DemoTermsLink label="Demo Terms" />);
  expect(screen.queryByRole("dialog", { name: "Gali Demo Terms" })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Demo Terms" }));
  expect(screen.getByRole("dialog", { name: "Gali Demo Terms" })).toBeTruthy();
  expect(screen.getByText(/research demo, provided “as is”/)).toBeTruthy();
  expect(screen.getByText(/Outputs may be inaccurate, and you are responsible for how you use them\./)).toBeTruthy();
  expect(screen.getByText(/You are responsible for the content you add\./)).toBeTruthy();
  expect(screen.queryByText(/API keys|charges/)).toBeNull();
  expect(screen.queryByText(/maximum extent permitted by law/)).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Gali Demo Terms" })).toBeNull();
});

test("the Privacy Notice points to the Vercel, Together AI, and OpenAI policies", async () => {
  render(<PrivacyLink label="Privacy Notice" />);
  await userEvent.click(screen.getByRole("button", { name: "Privacy Notice" }));
  expect(screen.getByRole("dialog", { name: "Privacy Notice" })).toBeTruthy();
  expect(screen.getByText(/Gali is a research preview\./)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Vercel privacy policy" }).getAttribute("href"))
    .toBe("https://vercel.com/legal/privacy-policy");
  expect(screen.getByRole("link", { name: "Together AI privacy policy" }).getAttribute("href"))
    .toBe("https://www.together.ai/privacy");
  expect(screen.getByRole("link", { name: "OpenAI privacy policy" }).getAttribute("href"))
    .toBe("https://openai.com/policies/row-privacy-policy/");
  expect(screen.queryByText(/privacy@together\.ai/)).toBeNull();
});
