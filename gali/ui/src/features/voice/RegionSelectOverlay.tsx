import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { WindowCapture } from "./capture-page";
import type { LookCaptureResult } from "../../realtime-client";
import { captureErrorMessage } from "./capture-page";
import {
  cropAndPrepareLookImage,
  mapDisplayRectToImage,
  normalizeSelectionRect,
  type Point,
  type SelectionRect,
} from "./selection-rect";

export function RegionSelectOverlay({
  capture,
  onComplete,
  adjustBeforeSend = false,
}: {
  capture: WindowCapture;
  onComplete: (result: LookCaptureResult) => void;
  adjustBeforeSend?: boolean;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imageReady, setImageReady] = useState(false);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [dragCurrent, setDragCurrent] = useState<Point | null>(null);
  const [pending, setPending] = useState<SelectionRect | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      onComplete({ status: "cancelled" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onComplete]);

  const preview =
    dragStart && dragCurrent && imgRef.current
      ? normalizeSelectionRect(dragStart, dragCurrent, {
          width: imgRef.current.clientWidth,
          height: imgRef.current.clientHeight,
        })
      : null;
  const shownRect = preview ?? pending;

  async function finish(displayRect: SelectionRect | null) {
    if (busy) return;
    if (!displayRect || !imgRef.current) {
      onComplete({ status: "cancelled" });
      return;
    }
    setBusy(true);
    try {
      const imageRect = mapDisplayRectToImage(
        displayRect,
        {
          width: imgRef.current.clientWidth,
          height: imgRef.current.clientHeight,
        },
        { width: capture.width, height: capture.height },
      );
      const image = await cropAndPrepareLookImage(capture.pngBase64, imageRect);
      onComplete({ status: "captured", mime: image.mime, base64: image.base64 });
    } catch (error) {
      onComplete({
        status: "failed",
        error: captureErrorMessage(error),
      });
    }
  }

  function pointFromEvent(event: ReactPointerEvent<HTMLDivElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };
  }

  return createPortal(
    <div
      className={[
        "region-select-overlay",
        adjustBeforeSend ? "adjust-before-send" : "",
        shownRect ? "has-rect" : "",
        pending ? "has-pending" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="dialog"
      aria-label="Select a region for Gali"
      onPointerDown={(event) => {
        if (busy || !imageReady) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const point = pointFromEvent(event);
        setPending(null);
        setDragStart(point);
        setDragCurrent(point);
      }}
      onPointerMove={(event) => {
        if (!dragStart || busy) return;
        setDragCurrent(pointFromEvent(event));
      }}
      onPointerUp={(event) => {
        if (!dragStart || busy) return;
        const end = pointFromEvent(event);
        const rect = imgRef.current
          ? normalizeSelectionRect(dragStart, end, {
              width: imgRef.current.clientWidth,
              height: imgRef.current.clientHeight,
            })
          : null;
        setDragStart(null);
        setDragCurrent(null);
        if (adjustBeforeSend) {
          setPending(rect);
          return;
        }
        void finish(rect);
      }}
    >
      <img
        ref={imgRef}
        className="region-select-bitmap"
        alt=""
        draggable={false}
        src={`data:image/png;base64,${capture.pngBase64}`}
        onLoad={() => setImageReady(true)}
      />
      <div className="region-select-dim" />
      {shownRect && (
        <div
          className="region-select-rect"
          style={{
            left: shownRect.x,
            top: shownRect.y,
            width: shownRect.width,
            height: shownRect.height,
          }}
        />
      )}
      <button
        type="button"
        className="region-select-cancel"
        disabled={busy}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onComplete({ status: "cancelled" });
        }}
      >
        Cancel
      </button>
      {adjustBeforeSend && !pending ? (
        <div className="region-select-hint">Drag a region for Gali to see</div>
      ) : null}
      {adjustBeforeSend && pending ? (
        <div
          className="region-select-sheet"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <p className="region-select-hint">Confirm to send, or retake</p>
          <div className="region-select-actions">
            <button
              type="button"
              className="region-select-retake"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                setPending(null);
              }}
            >
              Retake
            </button>
            <button
              type="button"
              className="region-select-confirm"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void finish(pending);
              }}
            >
              Confirm
            </button>
          </div>
        </div>
      ) : null}
      {!adjustBeforeSend ? (
        <div className="region-select-hint">
          Drag to select a region for Gali · Esc to cancel
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
