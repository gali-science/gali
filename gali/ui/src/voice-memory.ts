import { authenticatedFetch } from "./auth-fetch";

import type { VoiceMemoryDto } from "../../shared/domain/contracts";

type TranscriptLine =
  | { kind: "message"; role: string; text: string }
  | { kind: "tool"; name: string; args: unknown; result: unknown }
  | { kind: "status"; text: string };

const TRANSCRIPT_LINE_LIMIT = 120;
const TRANSCRIPT_CHAR_LIMIT = 16_000;

export function buildTranscript(lines: ReadonlyArray<TranscriptLine>): string {
  const parts: string[] = [];
  for (const line of lines) {
    if (line.kind === "message") {
      if (line.role !== "user" && line.role !== "assistant") continue;
      const text = line.text.trim();
      if (!text) continue;
      parts.push(`${line.role === "user" ? "User" : "Gali"}: ${text}`);
    } else if (line.kind === "tool") {
      parts.push(`[tool: ${line.name}]`);
    }
  }
  return parts.slice(-TRANSCRIPT_LINE_LIMIT).join("\n").slice(-TRANSCRIPT_CHAR_LIMIT);
}

export function asVoiceMemoryDto(value: unknown): VoiceMemoryDto | null {
  if (value == null || typeof value !== "object") return null;
  const rec = value as { summary?: unknown; uiLocation?: unknown; endedAt?: unknown };
  if (typeof rec.summary !== "string" || typeof rec.endedAt !== "string") return null;
  return {
    summary: rec.summary,
    uiLocation: typeof rec.uiLocation === "string" ? rec.uiLocation : "",
    endedAt: rec.endedAt,
  };
}

let hostedMemoryUnavailable = false;

export async function fetchHostedVoiceMemory(): Promise<VoiceMemoryDto | null> {
  if (hostedMemoryUnavailable) return null;
  const res = await authenticatedFetch("/api/memory", { method: "GET" });
  if (res.status === 401) {
    hostedMemoryUnavailable = true;
    return null;
  }
  if (!res.ok) return null;
  return asVoiceMemoryDto(await res.json());
}

export async function pushHostedVoiceMemory(input: {
  transcript?: string;
  uiLocation?: string;
}): Promise<void> {
  if (hostedMemoryUnavailable) return;
  const res = await authenticatedFetch("/api/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    // The End-press flush awaits this; a hung request must not stall teardown.
    signal: AbortSignal.timeout(5_000),
  });
  if (res.status === 401) {
    hostedMemoryUnavailable = true;
    return;
  }
  if (!res.ok) throw new Error(`memory save -> ${res.status}`);
}
