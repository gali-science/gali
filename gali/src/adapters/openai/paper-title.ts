import { PAPER_TITLE_INSTRUCTIONS, paperTitleFromReply } from "../../../shared/domain/paper-title.js";
import { fastModelText } from "./fast-model.js";

const TITLE_TIMEOUT_MS = 30_000;

/** The paper's title from its first page, or null when the page has none. */
export async function extractPaperTitle(firstPage: string): Promise<string | null> {
  const reply = await fastModelText({
    label: "paper title",
    instructions: PAPER_TITLE_INSTRUCTIONS,
    input: firstPage,
    maxOutputTokens: 400,
    timeoutMs: TITLE_TIMEOUT_MS,
  });
  return paperTitleFromReply(reply);
}
