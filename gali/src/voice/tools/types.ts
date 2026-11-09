import type { NavEvent } from "../../../shared/domain/contracts.js";
import type { AppContext } from "../../application/app-context.js";
import type { VoiceToolName } from "./schemas.js";

export type VoiceToolApp = Pick<
  AppContext,
  "projects" | "pdfAnnotations" | "review" | "reviewDocuments" | "visibleProjects" | "paperText" | "renameProject" | "deleteProject"
>;

export type ToolContext = {
  app: VoiceToolApp;
  onNav: (event: NavEvent) => void;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  realtimeSession: string,
) => Promise<unknown>;

export type ToolRegistry = { [Name in VoiceToolName]: ToolHandler };
export type ToolHandlerGroup<Name extends VoiceToolName> = {
  [Key in Name]: ToolHandler;
};
