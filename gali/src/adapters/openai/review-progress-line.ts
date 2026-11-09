import { fastModelText } from "./fast-model.js";

const PROGRESS_TIMEOUT_MS = 20_000;

const PROGRESS_INSTRUCTIONS = `You watch an AI agent that is checking a PDF (a scientific paper, slides, a chapter, or notes) and its code. You get the agent's latest actions: shell commands with the start of their output, page images it looked at, and its own notes. Reply with what it is doing right now in at most 8 words, as a present-tense phrase for a non-programmer, e.g. "Comparing the weight update in dro.py with Algorithm 1". Name the concrete thing (equation, table, page, file) when the actions show it. No file paths, no shell jargon, no trailing period.`;

/** Luna's few-word line for the reviewer's latest actions. */
export async function reviewProgressLine(input: { previous: string | null; actions: string[] }): Promise<string> {
  const reply = await fastModelText({
    label: "review progress",
    instructions: PROGRESS_INSTRUCTIONS,
    input: `${input.previous ? `Previous status: ${input.previous}\n\n` : ""}Latest actions, oldest first:\n${input.actions.join("\n\n")}`,
    maxOutputTokens: 400,
    timeoutMs: PROGRESS_TIMEOUT_MS,
  });
  return reply.replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").replace(/\.$/, "").trim();
}
