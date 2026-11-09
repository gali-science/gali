import { useEffect } from "react";
import { useRegistry } from "@embedpdf/core/react";
import { DocumentContent } from "@embedpdf/plugin-document-manager/react";
import { PdfDoc } from "../pdf/PdfDoc";
import { PdfReader } from "../pdf/PdfReader";
import { PDF_DOCUMENT_ID } from "../pdf/pdf-engine";

export type TryFile = { id: string; name: string; data: ArrayBuffer };

// The fast model's context cap; a long file keeps its first pages.
const FILE_TEXT_CHARS = 120_000;

const noop = () => {};

function FileText({
  onText,
  onError,
}: {
  onText: (text: { text: string; pageCount: number }) => void;
  onError: (message: string) => void;
}) {
  const { registry, documents } = useRegistry();
  const doc = documents[PDF_DOCUMENT_ID]?.document ?? null;

  useEffect(() => {
    if (!registry || !doc) return;
    let cancelled = false;
    void (async () => {
      const engine = registry.getEngine();
      const pages: string[] = [];
      for (let index = 0; index < doc.pageCount; index += 1) {
        const text = await engine.extractText(doc, [index]).toPromise();
        pages.push(`=== page ${index + 1} ===\n${text.trim()}`);
      }
      if (!cancelled) onText({ text: pages.join("\n\n").slice(0, FILE_TEXT_CHARS), pageCount: doc.pageCount });
    })().catch((error: unknown) => {
      if (!cancelled) onError(`Could not read the text of this PDF: ${String(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [registry, doc, onText, onError]);

  return null;
}

export function TryReader({
  file,
  page,
  onPageChange,
  onText,
  onError,
}: {
  file: TryFile;
  page: number;
  onPageChange: (page: number) => void;
  onText: (text: { text: string; pageCount: number }) => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="tile-viewer-pdf">
      <PdfDoc data={file.data} identity={file.id} name={file.name} interactive>
        <DocumentContent documentId={PDF_DOCUMENT_ID}>
          {({ isError, isLoaded }) =>
            isError
              ? <div className="form-error">This PDF could not be opened.</div>
              : isLoaded
                ? (
                  <>
                    <FileText onText={onText} onError={onError} />
                    <PdfReader
                      page={page}
                      annotations={[]}
                      onPageChange={onPageChange}
                      onViewChanging={noop}
                      onViewSettled={noop}
                      onScrollKey={noop}
                    />
                  </>
                )
                : <p className="code-preview-loading">Loading PDF…</p>}
        </DocumentContent>
      </PdfDoc>
    </div>
  );
}
