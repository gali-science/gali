import { pdfNoteHandlers } from "./handlers/pdf-notes.js";
import { projectHandlers } from "./handlers/projects.js";
import { voiceToolSchemas, type VoiceToolName } from "./schemas.js";
import type { ToolContext, ToolHandlerGroup, ToolRegistry } from "./types.js";

export const INLINE_TOOL_NAMES = [
  "wait_for_user",
  "look_at_window",
] as const satisfies readonly VoiceToolName[];

function assembleRegistry(
  groups: ReadonlyArray<Partial<ToolRegistry>>,
): ToolRegistry {
  const schemas = voiceToolSchemas();
  const schemaNames = new Set<string>();
  for (const schema of schemas) {
    if (schemaNames.has(schema.name)) {
      throw new Error(`duplicate voice tool schema '${schema.name}'`);
    }
    schemaNames.add(schema.name);
  }

  const registry: Partial<ToolRegistry> = {};
  for (const group of groups) {
    for (const [name, handler] of Object.entries(group)) {
      if (!schemaNames.has(name)) throw new Error(`unknown voice tool handler '${name}'`);
      if (name in registry) throw new Error(`duplicate voice tool handler '${name}'`);
      registry[name as VoiceToolName] = handler;
    }
  }
  for (const name of schemaNames) {
    if (!(name in registry)) throw new Error(`missing voice tool handler '${name}'`);
  }
  return registry as ToolRegistry;
}

export function createToolRegistry(context: ToolContext): ToolRegistry {
  const inlineHandlers: ToolHandlerGroup<(typeof INLINE_TOOL_NAMES)[number]> = {
    async wait_for_user() {
      return { waiting: true };
    },
    async look_at_window() {
      return { opened: true };
    },
  };
  return assembleRegistry([
    projectHandlers(context),
    pdfNoteHandlers(context),
    inlineHandlers,
  ]);
}