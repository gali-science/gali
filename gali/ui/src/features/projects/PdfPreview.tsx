import { useDocumentState } from "@embedpdf/core/react";
import { DocumentContent } from "@embedpdf/plugin-document-manager/react";
import { RenderLayer } from "@embedpdf/plugin-render/react";
import { Scroller } from "@embedpdf/plugin-scroll/react";
import { Viewport } from "@embedpdf/plugin-viewport/react";
import { PdfDoc } from "../pdf/PdfDoc";
import { PDF_DOCUMENT_ID } from "../pdf/pdf-engine";

function PdfPages() {
  // The page count comes from the document, not the scroll plugin: scroll only
  // learns the total once its viewport has measured a layout.
  const pages = useDocumentState(PDF_DOCUMENT_ID)?.document?.pageCount ?? 0;

  return (
    <>
      <div className="source-file-pdf-meta">
        {pages > 0 ? `${pages} page${pages === 1 ? "" : "s"}` : "Loading…"}
      </div>
      <Viewport documentId={PDF_DOCUMENT_ID} className="source-file-pdf-pages">
        <Scroller
          documentId={PDF_DOCUMENT_ID}
          renderPage={(page) => (
            <div className="source-file-pdf-page" data-page={page.pageNumber}>
              <RenderLayer
                documentId={PDF_DOCUMENT_ID}
                pageIndex={page.pageIndex}
                className="source-file-pdf-page-sheet"
              />
            </div>
          )}
        />
      </Viewport>
    </>
  );
}

export function PdfPreview({ data, identity }: { data: ArrayBuffer; identity: string }) {
  return (
    <div className="source-file-pdf">
      <PdfDoc data={data} identity={identity} name="document.pdf">
        <DocumentContent documentId={PDF_DOCUMENT_ID}>
          {({ isError }) =>
            isError
              ? <div className="form-error">This PDF could not be opened.</div>
              : <PdfPages />}
        </DocumentContent>
      </PdfDoc>
    </div>
  );
}
