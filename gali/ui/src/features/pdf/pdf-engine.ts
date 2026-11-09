/**
 * The registry is per-surface, so every surface names its document the same.
 *
 * The engine itself comes from usePdfiumEngine in PdfDoc. Building one by hand
 * with createPdfiumEngine to share a single worker looked cheaper, but the
 * engine it hands back never answers: documents sit at status "loading" with no
 * error, forever. Use the hook.
 */
export const PDF_DOCUMENT_ID = "gali-pdf";
