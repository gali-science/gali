export type TryTurn = { role: "user" | "assistant"; text: string };

export class TryLimitError extends Error {}

export class TryBusyError extends Error {}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: unknown; busy?: unknown } | null;
    const message = typeof detail?.error === "string" ? detail.error : `request failed (${response.status})`;
    if (response.status !== 429) throw new Error(message);
    throw detail?.busy === true ? new TryBusyError(message) : new TryLimitError(message);
  }
  return (await response.json()) as T;
}

export function startTryVoiceCall(sdp: string): Promise<{ sdp: string; call: string }> {
  return post("/api/try/session", { sdp });
}

export async function extendTryVoiceCall(call: string): Promise<void> {
  await post("/api/try/extend", { call });
}

export function endTryVoiceCall(call: string): void {
  void fetch("/api/try/end", {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call }),
  }).catch(() => {});
}

export async function askTryTitle(firstPage: string): Promise<string | null> {
  const { title } = await post<{ title: string | null }>("/api/try/title", { firstPage });
  return title;
}

export async function askTryQuestion(input: {
  question: string;
  fileText: string;
  page: number;
  history: readonly TryTurn[];
}): Promise<string> {
  const { answer } = await post<{ answer: string }>("/api/try/answer", input);
  return answer;
}
