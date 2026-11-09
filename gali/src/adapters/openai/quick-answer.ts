import { fastModelText } from "./fast-model.js";

const QUICK_ANSWER_TIMEOUT_MS = 45_000;
const PAPER_CONTEXT_CHARS = 120_000;

const QUICK_ANSWER_INSTRUCTIONS = "You answer quick questions about a PDF (a scientific paper, slides, a chapter, or notes) for a voice assistant that reads your reply aloud. Answer in one to three short spoken sentences, answer first. No markdown, no lists, no LaTeX: say math in words. Ground the answer in the PDF text when it is given and say so plainly when the PDF does not cover it. Never invent page numbers, figures, or numbers. A page is the N of the \"=== page N ===\" marker above the text; numbers printed in the PDF itself, such as proceedings page numbers in headers or footers, are not pages, so never give them as one.";

export async function quickAnswer(input: { question: string; paperText: string | null }): Promise<string> {
  const paper = input.paperText === null
    ? "No PDF text is available."
    : `Paper text (pages marked "=== page N ==="):\n${input.paperText.slice(0, PAPER_CONTEXT_CHARS)}`;
  return fastModelText({
    label: "quick answer",
    instructions: QUICK_ANSWER_INSTRUCTIONS,
    input: `${paper}\n\nQuestion: ${input.question}`,
    maxOutputTokens: 2000,
    timeoutMs: QUICK_ANSWER_TIMEOUT_MS,
  });
}
