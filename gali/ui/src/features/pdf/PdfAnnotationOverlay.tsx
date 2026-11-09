import { useState, type CSSProperties } from "react";
import { PDF_ANNOTATION_RGB, type ReviewPaperAnchor } from "../../../../shared/domain/contracts";
import type { PdfAnnotationDto } from "../../api";

const percent = (value: number, of: number) => `${(value / of) * 100}%`;

/** A passage someone jumped to from the review; it fades and is never saved. */
export type PdfFlash = ReviewPaperAnchor & { nonce: number };

export function PdfFlashOverlay({ pageNumber, flash }: { pageNumber: number; flash: PdfFlash | null }) {
  if (!flash || flash.page !== pageNumber) return null;
  return (
    <div className="pdf-page-overlay pdf-flash" key={flash.nonce} aria-hidden="true">
      {flash.rects.map((rect, index) => (
        <span
          key={index}
          className="pdf-flash-mark"
          style={{
            left: percent(rect.x, flash.pageWidth),
            top: percent(rect.y, flash.pageHeight),
            width: percent(rect.width, flash.pageWidth),
            height: percent(rect.height, flash.pageHeight),
          }}
        />
      ))}
    </div>
  );
}

export function PdfAnnotationOverlay({
  pageNumber,
  annotations,
}: {
  pageNumber: number;
  annotations: readonly PdfAnnotationDto[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const onPage = annotations.filter((item) => item.page === pageNumber);
  if (onPage.length === 0) return null;
  return (
    <div className="pdf-page-overlay pdf-annotations">
      {onPage.map((item) => {
        const first = item.rects[0];
        const isOpen = open === item.number;
        return (
          <div
            key={item.number}
            className={`pdf-annotation${isOpen ? " is-open" : ""}`}
            style={{ "--annotation-rgb": PDF_ANNOTATION_RGB[item.color].join(" ") } as CSSProperties}
          >
            {item.rects.map((rect, index) => (
              <span
                key={index}
                className="pdf-annotation-mark"
                aria-hidden="true"
                style={{
                  left: percent(rect.x, item.pageWidth),
                  top: percent(rect.y, item.pageHeight),
                  width: percent(rect.width, item.pageWidth),
                  height: percent(rect.height, item.pageHeight),
                }}
              />
            ))}
            <span
              className={`pdf-annotation-anchor${first ? "" : " is-page-note"}`}
              style={first
                ? {
                  left: percent(first.x + first.width, item.pageWidth),
                  top: percent(first.y, item.pageHeight),
                }
                : { right: "2%", top: "2%" }}
            >
              <button
                type="button"
                className={`pdf-annotation-pin${item.note ? " has-note" : ""}`}
                aria-label={item.note ? `Note ${item.number}` : `Highlight ${item.number}`}
                aria-expanded={item.note ? isOpen : undefined}
                // The PDF viewport starts text selection on pointerdown; a pin click is not one.
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => setOpen(isOpen ? null : item.number)}
              >
                {item.number}
              </button>
              {item.note ? (
                <span className="pdf-annotation-note" role="note">
                  <span className="pdf-annotation-note-number">{item.number}</span>
                  {item.note}
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}
