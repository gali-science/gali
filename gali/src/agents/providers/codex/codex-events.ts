import type { ProviderTurnEvent } from "../../core/types.js";

// The model already received the full output through the provider session; a
// command that dumps a large file must not balloon the event we hand back.
const MAX_COMMAND_OUTPUT_CHARS = 64 * 1024;

/** The app-server ThreadItem variants Gali reads; the rest map to nothing. */
export type CodexItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string; summary: string[]; content: string[] }
  | { type: "commandExecution"; id: string; command: string; status: string; aggregatedOutput: string | null; exitCode: number | null }
  | { type: "fileChange"; id: string; changes: { path: string }[]; status: string }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string }
  | { type: "imageView"; id: string; path: string }
  | { type: string; id: string };

function clipCommandOutput(output: string): string {
  if (output.length <= MAX_COMMAND_OUTPUT_CHARS) return output;
  const omitted = output.length - MAX_COMMAND_OUTPUT_CHARS;
  return `${output.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n… [truncated ${omitted} characters]`;
}

export function mapCodexItem(item: CodexItem): ProviderTurnEvent | null {
  switch (item.type) {
    case "agentMessage": {
      const message = item as Extract<CodexItem, { type: "agentMessage" }>;
      return { type: "message", text: message.text };
    }
    case "reasoning": {
      const reasoning = item as Extract<CodexItem, { type: "reasoning" }>;
      const text = [...reasoning.summary, ...reasoning.content].join("\n").trim();
      return text ? { type: "reasoning", text } : null;
    }
    case "commandExecution": {
      const command = item as Extract<CodexItem, { type: "commandExecution" }>;
      return {
        type: "command",
        command: command.command,
        status: command.status,
        ...(command.aggregatedOutput === null ? {} : { output: clipCommandOutput(command.aggregatedOutput) }),
        ...(command.exitCode === null ? {} : { exitCode: command.exitCode }),
      };
    }
    case "fileChange": {
      const change = item as Extract<CodexItem, { type: "fileChange" }>;
      return { type: "files", paths: change.changes.map((entry) => entry.path), status: change.status };
    }
    case "mcpToolCall": {
      const call = item as Extract<CodexItem, { type: "mcpToolCall" }>;
      return { type: "tool", name: `${call.server}.${call.tool}`, status: call.status };
    }
    case "imageView":
      return { type: "image", path: (item as Extract<CodexItem, { type: "imageView" }>).path };
    default:
      return null;
  }
}
