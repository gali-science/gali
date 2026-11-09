export type ProjectDto = {
  key: string;
  title: string;
  /** Relative to the project folder, e.g. "paper/attention.pdf"; null for a project with no PDF. */
  paperPath: string | null;
  /** The title printed on the paper; null until it is read, or when the PDF has none. */
  paperTitle: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Where the paper and the released code live inside every project folder. */
export const PAPER_DIR = "paper";
export const CODE_DIR = "code";

/** The browser packs one upload zip: the PDF under paper/ and, when given, the code zip untouched. */
export const UPLOAD_CODE_ZIP = "code.zip";

export const MAX_PAPER_BYTES = 100 * 1024 * 1024;
export const MAX_CODE_ZIP_BYTES = 100 * 1024 * 1024;

/** A public GitHub repository, as https://github.com/owner/repo; returns the clone URL or null. */
export function githubCloneUrl(link: string): string | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(link.trim());
  return match ? `https://github.com/${match[1]}/${match[2]}.git` : null;
}

export type ProjectFileDto = {
  path: string;
  kind: "text" | "audio" | "image" | "video" | "pdf" | "data" | "binary";
  binary: boolean;
  bytes: number;
};

export type ProjectTreeDto = { path: string; entries: ProjectFileDto[] };

export type ProjectSourceReadDto = {
  file: ProjectFileDto;
  content: string;
  truncated?: boolean;
  nextOffset?: number;
};

export type DeleteProjectResult = {
  deleted: true;
  projectKey: string;
  title: string;
};

export type VoiceMemoryDto = {
  summary: string;
  uiLocation: string;
  endedAt: string;
};

export type WindowCapture = {
  pngBase64: string;
  width: number;
  height: number;
};

export type ReviewerEvent =
  | { projectKey: string; type: "reviewer.started"; question: string; summary: string }
  | { projectKey: string; type: "reviewer.finished"; status: "succeeded"; message: string; quiet?: true }
  | { projectKey: string; type: "reviewer.finished"; status: "failed"; error: string }
  | { projectKey: string; type: "reviewer.finished"; status: "cancelled" }
  | { projectKey: string; type: "reviewer.reviewing"; running: boolean };

/** One line of the reviewer's live log: what it was doing, and the commands behind it. */
export type ReviewProgressEntry = { text: string; at: number; commands: string[] };

/** One raw step of the agent CLI, as the Agent tab's terminal shows it. Background lines come from a subagent. */
export type AgentTraceLine = {
  at: number;
  kind: "command" | "reasoning" | "message" | "files" | "tool" | "image";
  text: string;
  output: string | null;
  exitCode: number | null;
  background: boolean;
};

export type ReviewProgressEvent =
  | { projectKey: string; entry: ReviewProgressEntry }
  | { projectKey: string; trace: AgentTraceLine };

/** The agent's current run, or its last one once it went quiet (finishedAt set); null before any run. */
export type ReviewProgressDto = {
  title: string;
  startedAt: number;
  finishedAt: number | null;
  entries: ReviewProgressEntry[];
  trace: AgentTraceLine[];
} | null;

/** The reviewer may have written files into the project folder. */
export type ProjectEvent = {
  projectKey: string;
  type: "project.changed";
};

export const PDF_ANNOTATION_COLORS = ["yellow", "green", "blue", "pink", "orange"] as const;
export type PdfAnnotationColor = (typeof PDF_ANNOTATION_COLORS)[number];

/** The one palette for highlights: the viewer overlay and the exported PDF both draw from it. */
export const PDF_ANNOTATION_RGB: Record<PdfAnnotationColor, readonly [number, number, number]> = {
  yellow: [255, 214, 10],
  green: [52, 199, 89],
  blue: [10, 132, 255],
  pink: [255, 55, 145],
  orange: [255, 149, 0],
};

/** Top-left origin, in PDF points of the unrotated page. */
export type PdfRect = { x: number; y: number; width: number; height: number };

/** A highlight (rects + quote), optionally with a note; a page note has no rects. */
export type PdfAnnotationDto = {
  number: number;
  page: number;
  pageWidth: number;
  pageHeight: number;
  rects: PdfRect[];
  quote: string | null;
  note: string | null;
  color: PdfAnnotationColor;
  createdAt: string;
  /** Set when the user kept a review finding with "Add to notes"; absent on their own notes. */
  findingId?: string;
};

export const PDF_ANNOTATION_EXPORT_FORMATS = ["pdf", "markdown"] as const;
export type PdfAnnotationExportFormat = (typeof PDF_ANNOTATION_EXPORT_FORMATS)[number];

export function isPdfAnnotationExportFormat(value: unknown): value is PdfAnnotationExportFormat {
  return PDF_ANNOTATION_EXPORT_FORMATS.includes(value as PdfAnnotationExportFormat);
}

/** How an annotation reads outside Gali's voice: "3. note", or "3." with no note. */
export function pdfAnnotationLabel(item: Pick<PdfAnnotationDto, "number" | "note">): string {
  return item.note ? `${item.number}. ${item.note}` : `${item.number}.`;
}

/** The one file the reviewer writes for the user, at the project folder root. */
export const REVIEW_FILE = "review.json";

export const REVIEW_SEVERITIES = ["serious", "minor", "ok", "study"] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export type ReviewRef =
  | { paper: { page: number; quote: string; place?: string } }
  | { code: { path: string; lines: [number, number] } };

export type ReviewVisual =
  | { figure: { path: string; caption: string } }
  | {
      chart: {
        kind: "line" | "bar";
        caption: string;
        x: { label: string; values: Array<number | string> };
        series: Array<{ name: string; values: number[] }>;
      };
    }
  | { table: { caption: string; columns: string[]; rows: string[][] } };

export type ReviewFinding = {
  id: string;
  severity: ReviewSeverity;
  title: string;
  body: string;
  refs: ReviewRef[];
  visuals: ReviewVisual[];
};

export type ReviewDocument = {
  title: string;
  findings: ReviewFinding[];
};

/** Where a paper ref's quote sits, so a click can flash it without another lookup. */
export type ReviewPaperAnchor = {
  page: number;
  pageWidth: number;
  pageHeight: number;
  rects: PdfRect[];
};

/** Written by the app for the reviewer to read; the reviewer never edits it. */
export const USER_NOTES_FILE = "USER_NOTES.md";

export type ReviewDismissal = {
  id: string;
  title: string;
  body: string;
  dismissedAt: string;
};

export type ReviewDto = {
  /** Null when review.json is missing or unreadable; problems then says why. */
  document: ReviewDocument | null;
  updatedAt: string;
  problems: string[];
  /** Keyed `${findingId}:${refIndex}`; null when the quote was not found. */
  anchors: Record<string, ReviewPaperAnchor | null>;
  /** Findings the human dismissed; the panel hides them and the reviewer must not raise them again. */
  dismissed: ReviewDismissal[];
};

export const PROJECT_TABS = ["review", "notes", "chat", "code"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

export type NavEvent =
  | { type: "open_home" }
  | { type: "open_project"; projectKey: string }
  | { type: "open_paper"; projectKey: string; page?: number }
  | { type: "open_code_file"; projectKey: string; path: string; lines?: [number, number] }
  | { type: "set_viewer_page"; projectKey: string; page?: number; direction?: "next" | "prev" }
  | { type: "show_tab"; projectKey: string; tab: ProjectTab }
  | { type: "pdf_annotations_changed"; projectKey: string }
  | { type: "download_pdf_annotations"; projectKey: string; format: PdfAnnotationExportFormat }
  | { type: "open_project_actions"; projectKey: string }
  | { type: "close_project_actions"; projectKey: string }
  | { type: "navigate_back" }
  | { type: "open_transcript" }
  | { type: "close_transcript" }
  | { type: "open_new_project"; title?: string }
  | { type: "close_new_project" }
  | { type: "set_mic_muted"; muted: boolean }
  | { type: "end_voice" };
