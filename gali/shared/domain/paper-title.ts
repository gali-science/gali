const NO_TITLE = "NONE";

export const PAPER_TITLE_INSTRUCTIONS = `You read the text layer of a scientific paper's first page and reply with the paper's title only: no quotes, no authors, no venue, no trailing period. Join a title broken across lines. If the title is printed in capitals or small capitals, write it in normal title case and keep acronyms as printed. If the text holds no title, reply ${NO_TITLE}.`;

export function paperTitleFromReply(reply: string): string | null {
  const title = reply.replace(/\s+/g, " ").replace(/^["“]|["”]$/g, "").trim();
  return title === NO_TITLE || title.length > 300 ? null : title;
}
