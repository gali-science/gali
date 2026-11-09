import { runVoiceTool } from "../api";

/** A note with no anchor goes on the paper page on screen. */
export function anchorNoteToViewer(
  name: string,
  args: Record<string, unknown>,
  viewer: { path: string; page: number } | null,
): Record<string, unknown> {
  if ((name !== "add_pdf_note" && name !== "add_finding_to_notes") || viewer === null) return args;
  if (args.number !== undefined || args.quote !== undefined || args.page !== undefined) return args;
  return { ...args, page: viewer.page };
}

// The browser performs these downloads after the tool returns; where it cannot, the tool must not claim it started.
const DOWNLOAD_TOOLS = new Set(["download_annotated_pdf", "download_pdf_notes"]);

export const DOWNLOAD_UNAVAILABLE =
  "This app cannot save downloads to the device. Tell the user downloads work in Gali on the web.";

export class RealtimeToolDispatcher {
  constructor(
    private readonly session: string,
    private readonly canDownload: () => boolean,
  ) {}

  async dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (DOWNLOAD_TOOLS.has(name) && !this.canDownload()) return { error: DOWNLOAD_UNAVAILABLE };
    try {
      return await runVoiceTool(name, args, this.session);
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
}
