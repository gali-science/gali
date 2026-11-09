export type TileCaptureTarget = {
  /** Null is the paper viewer. */
  path: string | null;
  page?: number;
};

export const TILE_VIEW_TOOLS = new Set([
  "open_paper",
  "open_code_file",
  "set_viewer_page",
  "go_to_pdf_note",
]);

export type OpenTileVisual = { path: string; page: number; scroll: string };

/** The paper and code panels can both be on screen; each viewer marks its own path. */
export function findViewElement(path: string | null): HTMLElement | null {
  const views = document.querySelectorAll<HTMLElement>('[data-tile-capture="true"]');
  for (const el of views) {
    if (path === null ? el.dataset.tileKind === "paper" : el.dataset.tilePath === path) return el;
  }
  return null;
}

export function readOpenTileVisual(path: string | null): OpenTileVisual | null {
  const el = findViewElement(path);
  if (!el) return null;
  const found = el.dataset.tilePath?.trim();
  if (!found) return null;
  const page = Number(el.dataset.tilePage);
  return {
    path: found,
    page: Number.isInteger(page) && page > 0 ? page : 1,
    scroll: el.dataset.tileScroll?.trim() || "0:0",
  };
}

export function readOpenTilePage(path: string | null): number | null {
  const raw = findViewElement(path)?.dataset.tilePage;
  const page = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(page) && page > 0 ? page : null;
}

export function visualKey(path: string, page: number, scroll: string): string {
  return `${path}:${page}:${scroll}`;
}

export function openViewSilentText(where: string): string {
  return (
    `Silent context: this image is the current viewer crop${where}. `
    + "It is only what is on screen, not the file. "
    + "Name what is visible if asked. For meaning or detail, use quick_answer or ask_reviewer. "
    + "Do not respond to this message itself."
  );
}

function tileWhere(target: TileCaptureTarget): string {
  const page = target.page !== undefined ? `, page ${target.page}` : "";
  return target.path ? ` (file: ${target.path}${page})` : page ? ` (paper${page})` : "";
}

function onScreen(target: TileCaptureTarget, now: OpenTileVisual | null): now is OpenTileVisual {
  if (!now) return false;
  return target.page === undefined || now.page === target.page;
}

type Image = { mime: "image/jpeg" | "image/png"; base64: string };

export type LookCaptureResult =
  | { status: "captured"; mime: Image["mime"]; base64: string }
  | { status: "cancelled" }
  | { status: "failed"; error: string };

export type TileCaptureHandler = (target: TileCaptureTarget) => Promise<LookCaptureResult>;

type Status = { kind: "status"; text: string; mark?: { type: "view-shared" } };

export type AttachedViewPort = {
  send(event: unknown): void;
  status(event: Status): void;
  context(text: string): void;
};

export type ToolView = { result: unknown; afterOutput: (() => void) | null };

const CAPTURED = "captured — the opened content is attached as an image in this conversation";
const ARRIVING =
  "arriving — the image of this view is attached in a moment as silent context. Confirm the open in a few words; do not describe or characterize its content in this reply";

/**
 * The one image the model has attached: a focused viewer or a Look crop.
 * Each new image replaces the last; a capture that finishes after a newer
 * view or a view the screen has left is dropped.
 */
export class AttachedView {
  private capture: TileCaptureHandler | null = null;
  private itemId: string | null = null;
  private viewKey: string | null = null;
  private generation = 0;

  constructor(private readonly port: AttachedViewPort) {}

  setCaptureHandler(handler: TileCaptureHandler | null) {
    this.capture = handler;
  }

  attach(image: Image, text: string, status: Status | null, viewKey: string | null = null) {
    if (this.itemId) this.port.send({ type: "conversation.item.delete", item_id: this.itemId });
    const itemId = `look_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    this.itemId = itemId;
    this.viewKey = viewKey;
    if (status) this.port.status(status);
    this.port.send({
      type: "conversation.item.create",
      item: {
        id: itemId,
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: `data:${image.mime};base64,${image.base64}`, detail: "high" },
          { type: "input_text", text },
        ],
      },
    });
  }

  clear() {
    this.generation += 1;
    if (this.itemId) this.port.send({ type: "conversation.item.delete", item_id: this.itemId });
    this.itemId = null;
    this.viewKey = null;
  }

  reset() {
    this.generation += 1;
    this.itemId = null;
    this.viewKey = null;
  }

  /** The user moved a viewer: re-attach it silently unless it already is. */
  async follow(target: { path: string; page: number }): Promise<void> {
    const before = readOpenTileVisual(target.path);
    const key = onScreen(target, before)
      ? visualKey(before.path, before.page, before.scroll)
      : visualKey(target.path, target.page, "0:0");
    if (this.showing(key)) return;
    await this.captureAndAttach(target, null);
  }

  /**
   * Annotate a viewer tool's result with whether the model has seen the view.
   * With wait, the image is attached before returning; without, afterOutput
   * attaches it once the tool output is in the conversation.
   */
  async forTool(
    name: string,
    result: unknown,
    pageBefore: number | null,
    wait: boolean,
  ): Promise<ToolView> {
    const target = tileViewTarget(name, result, pageBefore);
    if (target === undefined) return { result, afterOutput: null };
    const view = (text: string, afterOutput: (() => void) | null = null): ToolView => ({
      result: { ...(result as object), view: text },
      afterOutput,
    });
    if (!this.capture) {
      return view("not received — you have NOT seen this content; do not describe or characterize it");
    }
    const now = readOpenTileVisual(target.path);
    if (onScreen(target, now) && this.showing(visualKey(now.path, now.page, now.scroll))) {
      return view(CAPTURED);
    }
    if (!wait) {
      return view(ARRIVING, () => {
        void this.captureAndAttach(target, null).then((missed) => {
          if (missed) {
            this.port.context(
              `The view you just opened${tileWhere(target)} did not come through (${missed}). You have NOT seen it: do not describe or characterize it; if asked, say you couldn't see it and offer to open it again.`,
            );
          }
        });
      });
    }
    const missed = await this.captureAndAttach(target, {
      kind: "status",
      text: "Shared the opened view with Gali",
      mark: { type: "view-shared" },
    });
    return missed
      ? view(`not received (${missed}) — you have NOT seen this content; do not describe or characterize it`)
      : view(CAPTURED);
  }

  private showing(key: string): boolean {
    return this.itemId !== null && this.viewKey === key;
  }

  /** Resolves to null once attached or superseded, or to why the view was not seen. */
  private async captureAndAttach(target: TileCaptureTarget, status: Status | null): Promise<string | null> {
    if (!this.capture) return "the viewer is not ready";
    const generation = ++this.generation;
    const capture = await this.capture(target);
    if (generation !== this.generation) return null;
    if (capture.status !== "captured") return capture.status === "failed" ? capture.error : "cancelled";
    const now = readOpenTileVisual(target.path);
    if (!onScreen(target, now)) return "the viewer moved on before the image was taken";
    this.attach(
      { mime: capture.mime, base64: capture.base64 },
      openViewSilentText(tileWhere(target)),
      status,
      visualKey(now.path, now.page, now.scroll),
    );
    return null;
  }
}

export function tileViewTarget(
  name: string,
  result: unknown,
  pageBefore: number | null,
): TileCaptureTarget | undefined {
  if (!TILE_VIEW_TOOLS.has(name)) return undefined;
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as Record<string, unknown>;
  if (record.error !== undefined) return undefined;
  if (record.opened !== true && record.turned !== true) return undefined;
  const path = typeof record.path === "string" && record.path.trim() ? record.path : undefined;
  if (path === undefined) return undefined;
  if (name === "set_viewer_page") {
    const page = typeof record.page === "number" && Number.isInteger(record.page) && record.page > 0
      ? record.page
      : record.direction === "next" && pageBefore !== null
        ? pageBefore + 1
        : record.direction === "prev" && pageBefore !== null
          ? Math.max(1, pageBefore - 1)
          : undefined;
    return page === undefined ? { path } : { path, page };
  }
  return typeof record.page === "number" && Number.isInteger(record.page) && record.page > 0
    ? { path, page: record.page }
    : { path };
}
