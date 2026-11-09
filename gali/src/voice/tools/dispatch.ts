import { AmbiguousProject } from "./handlers/projects.js";
import type { ToolRegistry } from "./types.js";
import type { VoiceToolName } from "./schemas.js";

export async function dispatchVoiceTool(
  registry: ToolRegistry,
  name: string,
  args: Record<string, unknown>,
  realtimeSession: string,
): Promise<unknown> {
  if (!(name in registry)) throw new Error(`unknown tool '${name}'`);
  const handler = registry[name as VoiceToolName];
  try {
    return await handler(args, realtimeSession);
  } catch (error) {
    if (!(error instanceof AmbiguousProject)) throw error;
    return {
      needsClarification: true,
      matches: error.matches,
      note: "Several projects match. Ask the user once which one they mean, then call again with its key.",
    };
  }
}
