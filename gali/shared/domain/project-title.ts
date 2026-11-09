const MAX_SHORT_TITLE_CHARS = 60;

export function shortTitle(text: string): string {
  const words = text.trim().replace(/\s+/g, " ").replace(/[?.!]+$/, "").split(" ");
  let title = "";
  for (const word of words) {
    if (title && title.length + word.length + 1 > MAX_SHORT_TITLE_CHARS) break;
    title = title ? `${title} ${word}` : word;
  }
  return title;
}

export function titleFromPdfName(name: string): string {
  return name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
}

export function isPdfNameTitle(title: string, pdfName: string): boolean {
  const fromName = titleFromPdfName(pdfName);
  return title === fromName || title === shortTitle(fromName);
}
