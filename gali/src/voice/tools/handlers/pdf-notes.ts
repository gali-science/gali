import {
  PDF_ANNOTATION_COLORS,
  type PdfAnnotationColor,
  type PdfAnnotationDto,
  type PdfAnnotationExportFormat,
} from "../../../../shared/domain/contracts.js";
import { UserError } from "../../../lib/user-error.js";
import { requirePaperPath } from "../../../services/projects/project-service.js";
import type { VoiceToolName } from "../schemas.js";
import type { ToolContext, ToolHandlerGroup } from "../types.js";
import { resolveProjectKey } from "./projects.js";

export const PDF_NOTE_TOOL_NAMES = [
  "highlight_pdf_text",
  "add_pdf_note",
  "add_finding_to_notes",
  "list_pdf_notes",
  "go_to_pdf_note",
  "remove_pdf_note",
  "download_annotated_pdf",
  "download_pdf_notes",
] as const satisfies readonly VoiceToolName[];

type PdfNoteToolName = (typeof PDF_NOTE_TOOL_NAMES)[number];

const QUOTE_PREVIEW = 160;

function summary(item: PdfAnnotationDto) {
  return {
    number: item.number,
    page: item.page,
    kind: item.rects.length > 0 ? "highlight" : "page note",
    ...(item.quote === null
      ? {}
      : { quote: item.quote.length > QUOTE_PREVIEW ? `${item.quote.slice(0, QUOTE_PREVIEW)}…` : item.quote }),
    ...(item.note === null ? {} : { note: item.note }),
    color: item.color,
  };
}

function requiredText(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} must not be empty`);
  return text;
}

function optionalPage(value: unknown): number | undefined {
  return value === undefined ? undefined : Math.max(1, Math.trunc(Number(value)));
}

function color(value: unknown): PdfAnnotationColor | undefined {
  if (value === undefined) return undefined;
  if (!PDF_ANNOTATION_COLORS.includes(value as PdfAnnotationColor)) {
    throw new Error(`color must be one of ${PDF_ANNOTATION_COLORS.join(", ")}`);
  }
  return value as PdfAnnotationColor;
}

export function pdfNoteHandlers(context: ToolContext): ToolHandlerGroup<PdfNoteToolName> {
  const { app, onNav } = context;

  function show(projectKey: string, page: number) {
    onNav({ type: "open_paper", projectKey, page });
    onNav({ type: "pdf_annotations_changed", projectKey });
  }

  async function paper(args: Record<string, unknown>) {
    const project = await app.projects.get(await resolveProjectKey(app, args.projectKey));
    return { projectKey: project.key, path: requirePaperPath(project) };
  }

  async function download(args: Record<string, unknown>, format: PdfAnnotationExportFormat, note: string) {
    const { projectKey, path } = await paper(args);
    const count = (await app.pdfAnnotations.list(projectKey, path)).length;
    if (count === 0) throw new Error("the PDF has no highlights or notes to export");
    onNav({ type: "download_pdf_annotations", projectKey, format });
    return { started: true, projectKey, count, note };
  }

  return {
    async highlight_pdf_text(args) {
      const { projectKey, path } = await paper(args);
      const note = typeof args.note === "string" && args.note.trim() ? args.note : undefined;
      const page = optionalPage(args.page);
      const highlightColor = color(args.color);
      const { annotation, matches } = await app.pdfAnnotations.highlight({
        projectKey,
        path,
        quote: requiredText(args.text, "text"),
        ...(page === undefined ? {} : { page }),
        ...(highlightColor === undefined ? {} : { color: highlightColor }),
        ...(note === undefined ? {} : { note }),
      });
      show(projectKey, annotation.page);
      return {
        highlighted: true,
        projectKey,
        ...summary(annotation),
        ...(matches > 1
          ? { ambiguous: `the passage occurs ${matches} times; highlighted the one on page ${annotation.page}. Pass page, or a longer quote, to pick another.` }
          : {}),
      };
    },

    async add_pdf_note(args) {
      const { projectKey, path } = await paper(args);
      const text = requiredText(args.text, "text");
      const page = optionalPage(args.page);
      if (typeof args.quote === "string" && args.quote.trim()) {
        const { annotation } = await app.pdfAnnotations.highlight({
          projectKey,
          path,
          quote: args.quote,
          note: text,
          ...(page === undefined ? {} : { page }),
        });
        show(projectKey, annotation.page);
        return { noted: true, projectKey, ...summary(annotation) };
      }
      const annotation = await app.pdfAnnotations.addNote({
        projectKey,
        path,
        text,
        ...(args.number === undefined ? {} : { number: Math.trunc(Number(args.number)) }),
        ...(page === undefined ? {} : { page }),
      });
      show(projectKey, annotation.page);
      return { noted: true, projectKey, ...summary(annotation) };
    },

    async add_finding_to_notes(args) {
      const { projectKey, path } = await paper(args);
      const findingId = requiredText(args.findingId, "findingId");
      const review = await app.reviewDocuments.read(projectKey);
      const finding = review?.document?.findings.find((item) => item.id === findingId);
      if (!review || !finding) throw new UserError(`no finding ${findingId} in the review`);
      const existing = (await app.pdfAnnotations.list(projectKey, path)).find((item) => item.findingId === finding.id);
      if (existing) return { noted: true, projectKey, ...summary(existing) };
      const note = `${finding.title}. ${finding.body}`;
      const index = finding.refs.findIndex((ref) => "paper" in ref);
      const ref = finding.refs[index];
      const anchor = index >= 0 ? review.anchors[`${finding.id}:${index}`] : undefined;
      const page = optionalPage(args.page);
      const annotation = ref && "paper" in ref && anchor
        ? (await app.pdfAnnotations.highlight({ projectKey, path, quote: ref.paper.quote, page: anchor.page, note, color: "orange", findingId: finding.id })).annotation
        : await app.pdfAnnotations.addNote({ projectKey, path, text: note, ...(page === undefined ? {} : { page }), findingId: finding.id });
      show(projectKey, annotation.page);
      return { noted: true, projectKey, ...summary(annotation) };
    },

    async list_pdf_notes(args) {
      const { projectKey, path } = await paper(args);
      const items = await app.pdfAnnotations.list(projectKey, path);
      return { projectKey, count: items.length, annotations: items.map(summary) };
    },

    async go_to_pdf_note(args) {
      const { projectKey, path } = await paper(args);
      const item = await app.pdfAnnotations.get(projectKey, path, Math.trunc(Number(args.number)));
      onNav({ type: "open_paper", projectKey, page: item.page });
      return { opened: true, projectKey, path, ...summary(item) };
    },

    async remove_pdf_note(args) {
      const { projectKey, path } = await paper(args);
      const item = await app.pdfAnnotations.remove(projectKey, path, Math.trunc(Number(args.number)));
      onNav({ type: "pdf_annotations_changed", projectKey });
      return { removed: true, projectKey, ...summary(item) };
    },

    download_annotated_pdf: (args) =>
      download(args, "pdf", "The browser is downloading a copy of the PDF with the highlights and notes written in."),

    download_pdf_notes: (args) =>
      download(args, "markdown", "The browser is downloading the notes and highlighted passages as a markdown file, by page."),
  };
}
