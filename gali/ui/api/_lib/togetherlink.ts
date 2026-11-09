const DEFAULT_GATEWAY_ORIGIN = "https://gateway.togetherlink.dev";

export const TOGETHERLINK_CODEX_MODEL = "moonshotai/Kimi-K3";
export const TOGETHERLINK_FAST_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

export type TogetherLinkModelUsage = {
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
};

export type TogetherLinkUsage = {
  completedSessions: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalCostUsd: number;
  models: TogetherLinkModelUsage[];
};

function nonNegativeNumber(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`TogetherLink usage ${label} is invalid`);
  }
  return number;
}

function parseModelUsage(value: unknown): TogetherLinkModelUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TogetherLink model usage is invalid");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.model !== "string" || !row.model.trim()) {
    throw new Error("TogetherLink usage model is invalid");
  }
  return {
    model: row.model,
    promptTokens: nonNegativeNumber(row.promptTokens, `${row.model}.promptTokens`),
    cachedTokens: nonNegativeNumber(row.cachedTokens, `${row.model}.cachedTokens`),
    completionTokens: nonNegativeNumber(
      row.completionTokens,
      `${row.model}.completionTokens`,
    ),
    costUsd: nonNegativeNumber(row.costUsd, `${row.model}.costUsd`),
  };
}

export function parseTogetherLinkUsage(value: unknown): TogetherLinkUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("TogetherLink usage response is invalid");
  }
  const row = value as Record<string, unknown>;
  if (!Array.isArray(row.models)) {
    throw new Error("TogetherLink usage models are invalid");
  }
  return {
    completedSessions: nonNegativeNumber(row.completedSessions, "completedSessions"),
    promptTokens: nonNegativeNumber(row.promptTokens, "promptTokens"),
    cachedTokens: nonNegativeNumber(row.cachedTokens, "cachedTokens"),
    completionTokens: nonNegativeNumber(row.completionTokens, "completionTokens"),
    totalCostUsd: nonNegativeNumber(row.totalCostUsd, "totalCostUsd"),
    models: row.models.map(parseModelUsage),
  };
}

export function useTogetherLink(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === "test") {
    return env.GALI_CODEX_UPSTREAM?.trim() === "togetherlink";
  }
  return true;
}

export function togetherLinkOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return (env.TOGETHERLINK_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_ORIGIN)
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
}

export function togetherLinkResponsesUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${togetherLinkOrigin(env)}/v1/responses`;
}

export async function readTogetherLinkUsage(input: {
  apiKey: string;
  sessionId: string;
  since: number;
  fetchImpl?: typeof fetch;
}): Promise<TogetherLinkUsage> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(`${togetherLinkOrigin()}/v1/togetherlink/usage`);
  url.searchParams.set("since", String(input.since));
  url.searchParams.set("session_id", input.sessionId);
  const waits = [0, 100, 500];
  for (const wait of waits) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`TogetherLink usage request failed with HTTP ${response.status}`);
    }
    const usage = parseTogetherLinkUsage(await response.json());
    if (usage.completedSessions > 0 || usage.models.length > 0) return usage;
  }
  throw new Error("TogetherLink usage was not ready after retries");
}

export function togetherLinkUsageRecord(usage: TogetherLinkUsage): Record<string, unknown> {
  return {
    input_tokens: usage.promptTokens,
    cached_input_tokens: usage.cachedTokens,
    output_tokens: usage.completionTokens,
    models: usage.models,
  };
}

export function togetherLinkCostMicros(usage: TogetherLinkUsage): number {
  const micros = Math.round(usage.totalCostUsd * 1_000_000);
  if (!Number.isSafeInteger(micros) || micros < 0) {
    throw new Error("TogetherLink usage cost is invalid");
  }
  return micros;
}
