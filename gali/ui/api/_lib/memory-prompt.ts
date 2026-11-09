export const MEMORY_OUTPUT_CONTRACT = {
  format: "plain_text",
  maxOutputTokens: 1000,
} as const;

export const MEMORY_SUMMARY_INSTRUCTIONS =
  "You summarize a voice conversation between a user and Gali, a voice research assistant, into a private memory note for Gali's next session. 120 words max, plain text only. Cover which projects the user worked on, questions Gali checked in depth and what came back, findings and decisions, open threads, and anything the user asked Gali to remember. Always record projects as title with exact key, e.g. Demo 2 (key: demo-2) — tool calls need the key, never the title. A previous note may be provided: carry over only items still relevant in this conversation; drop the rest. Output only the note.";

export type MemoryPromptInput = {
  readonly transcript: string;
  readonly previousSummary: string;
};

export function renderMemoryInput(input: MemoryPromptInput): string {
  return `${
    input.previousSummary.trim()
      ? `Previous note:\n${input.previousSummary.trim()}\n\n`
      : ""
  }Transcript:\n${input.transcript}`;
}
