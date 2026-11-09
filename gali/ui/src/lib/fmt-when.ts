const WHEN_FMT = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function fmtWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t) || t === 0) return "—";
  const diff = t - Date.now();
  const days = Math.round(diff / 86400000);
  if (Math.abs(days) < 1) {
    const hours = Math.round(diff / 3600000);
    if (Math.abs(hours) < 1) return "today";
    return WHEN_FMT.format(hours, "hour");
  }
  if (Math.abs(days) < 14) return WHEN_FMT.format(days, "day");
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(iso));
}
