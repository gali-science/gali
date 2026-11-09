export type RealtimeServerEvent = { type: string; [key: string]: unknown };

export function isActiveResponseError(event: RealtimeServerEvent): boolean {
  if (event.type !== "error") return false;
  const error = event.error as { message?: unknown; code?: unknown } | undefined;
  return String(error?.code ?? "") === "conversation_already_has_active_response"
    || /active response/i.test(String(error?.message ?? ""));
}
