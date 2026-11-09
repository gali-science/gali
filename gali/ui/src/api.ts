import type {
  NavEvent,
  PdfAnnotationDto,
  ProjectDto,
  ProjectFileDto,
  ProjectSourceReadDto,
  ProjectTreeDto,
  ReviewDto,
  ReviewProgressDto,
  ReviewProgressEvent,
  VoiceMemoryDto,
} from "../../shared/domain/contracts";
import type { GaliClient, SeqProjectEvent, SeqReviewerEvent } from "./http-bridge";
import { getPlatform } from "./platform/runtime";

export type {
  NavEvent,
  PdfAnnotationDto,
  ProjectDto,
  ProjectFileDto,
  ProjectSourceReadDto,
  ReviewDto,
  VoiceMemoryDto,
};
export type { SeqProjectEvent as ProjectEvent, SeqReviewerEvent as ReviewerEvent };

export type RealtimeTokenDto = {
  client_secret?: unknown;
  value?: string;
  model: string;
  metered?: boolean;
  turn_detection?: { eagerness?: unknown; interrupt_response?: unknown };
};

function client(): GaliClient {
  const g = getPlatform().client;
  if (!g) throw new Error("This action requires a connected Gali runtime.");
  return g;
}

const project = (key: string) => `/projects/${encodeURIComponent(key)}`;

export async function listProjects(): Promise<ProjectDto[]> {
  const g = getPlatform().client;
  return g ? g.json<ProjectDto[]>("GET", "/projects") : [];
}

export const getProject = (key: string) => client().json<ProjectDto>("GET", project(key));

export const deleteProject = (key: string, confirmTitle: string) =>
  client().json<{ deleted: true; projectKey: string; title: string }>("DELETE", project(key), { confirmTitle });

export const getProjectTree = (key: string, path = "", depth = 1) =>
  client().json<ProjectTreeDto>(
    "GET",
    `${project(key)}/tree?${new URLSearchParams({ path, depth: String(depth) })}`,
  );

export const readProjectFile = (key: string, path: string, offset = 0) =>
  client().json<ProjectSourceReadDto>(
    "GET",
    `${project(key)}/file?${new URLSearchParams({ path, offset: String(offset) })}`,
  );

export const readProjectMedia = (key: string, path: string) =>
  client().media(`${project(key)}/media?${new URLSearchParams({ path })}`);

export const getReview = (key: string) => client().json<ReviewDto | null>("GET", `${project(key)}/review`);

export const getReviewProgress = (key: string) =>
  client().json<ReviewProgressDto>("GET", `${project(key)}/review/progress`);

export const cancelReview = (key: string) =>
  client().json<{ cancelled: boolean }>("POST", `${project(key)}/review/cancel`);

export const dismissFinding = (key: string, id: string) =>
  client().json<ReviewDto>("POST", `${project(key)}/review/dismissed`, { id });

export const restoreFinding = (key: string, id: string) =>
  client().json<ReviewDto | null>("DELETE", `${project(key)}/review/dismissed/${encodeURIComponent(id)}`);

export const readPdfAnnotations = (key: string) =>
  client().json<PdfAnnotationDto[]>("GET", `${project(key)}/pdf-annotations`);

export const createPdfAnnotation = (
  key: string,
  input:
    | { quote: string; page?: number; note?: string; color?: PdfAnnotationDto["color"]; findingId?: string }
    | { page: number; note: string; findingId?: string },
) => client().json<PdfAnnotationDto>("POST", `${project(key)}/pdf-annotations`, input);

export const setPdfAnnotationNote = (key: string, number: number, note: string | null) =>
  client().json<PdfAnnotationDto | null>("PATCH", `${project(key)}/pdf-annotations/${number}`, { note });

export const deletePdfAnnotation = (key: string, number: number) =>
  client().json<PdfAnnotationDto>("DELETE", `${project(key)}/pdf-annotations/${number}`);

export const readProjectChat = (key: string) =>
  client().json<{ lines: unknown[] }>("GET", `${project(key)}/chat`);

export const saveProjectChat = (key: string, lines: unknown[]) =>
  client().json<{ saved: number }>("POST", `${project(key)}/chat`, { lines });

export const mintRealtimeToken = () => client().json<RealtimeTokenDto>("POST", "/realtime/token");

export const runVoiceTool = (name: string, args: Record<string, unknown>, session: string) =>
  client().runTool(name, args, session);

export function onNavEvent(cb: (e: NavEvent) => void): () => void {
  return getPlatform().client?.onNav(cb) ?? (() => {});
}

export function onReviewerEvent(cb: (e: SeqReviewerEvent) => void): () => void {
  return getPlatform().client?.onReviewer(cb) ?? (() => {});
}

export function onReviewProgress(cb: (e: ReviewProgressEvent) => void): () => void {
  return getPlatform().client?.onProgress(cb) ?? (() => {});
}

export function onBackendRestart(cb: () => void): () => void {
  return getPlatform().client?.onRestart(cb) ?? (() => {});
}

export function onProjectEvent(cb: (e: SeqProjectEvent) => void): () => void {
  return getPlatform().client?.onProject(cb) ?? (() => {});
}
