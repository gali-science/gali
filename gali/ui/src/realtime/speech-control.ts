export const UNMUTE_HOLD_MS = 600;

export function isAutoplayBlocked(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === "NotAllowedError";
}
