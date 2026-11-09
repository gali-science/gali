import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { voiceMemories, type VoiceMemoryRow } from "./db/schema.js";

const TRANSCRIPT_MAX_CHARS = 20_000;

export async function getVoiceMemoryRow(userId: number): Promise<VoiceMemoryRow | null> {
  const rows = await db()
    .select()
    .from(voiceMemories)
    .where(eq(voiceMemories.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export async function saveVoiceMemoryInput(
  userId: number,
  input: { transcript?: string; uiLocation?: string },
): Promise<void> {
  const now = new Date();
  const transcript =
    input.transcript === undefined ? undefined : input.transcript.slice(-TRANSCRIPT_MAX_CHARS);
  await db()
    .insert(voiceMemories)
    .values({
      userId,
      transcript: transcript ?? "",
      uiLocation: input.uiLocation ?? "",
      transcriptAt: transcript === undefined ? null : now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: voiceMemories.userId,
      set: {
        ...(transcript === undefined ? {} : { transcript, transcriptAt: now }),
        ...(input.uiLocation === undefined ? {} : { uiLocation: input.uiLocation }),
        updatedAt: now,
      },
    });
}

export async function saveVoiceMemorySummary(
  userId: number,
  summary: string,
  summarizedAt: Date,
): Promise<void> {
  await db()
    .update(voiceMemories)
    .set({ summary, summarizedAt, updatedAt: new Date() })
    .where(eq(voiceMemories.userId, userId));
}
