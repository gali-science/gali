export function formatAgo(ageMs: number): string {
  const minutes = Math.round(ageMs / 60_000);
  if (minutes < 2) return "moments ago";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export function parseToolArguments(value?: string): Record<string, unknown> {
  if (!value) return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {};
  }
}
