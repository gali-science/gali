/** The text shadow that sits beside a PDF: same name plus .txt. */
export function pdfShadowPath(pdfPath: string): string {
  return `${pdfPath}.txt`;
}

export function isPdfShadow(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf.txt");
}
