import { authenticatedFetch } from "./auth-fetch";

export type TrialStatusDto = {
  status: "active" | "exhausted";
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
};

export type ModelConsentDto = {
  version: number;
  accepted: boolean;
  voiceOpenAiAccepted: boolean;
  experimentsTogetherAccepted: boolean;
  acceptedAt: string | null;
};

export type AccountDto = {
  displayName: string;
  identityEmail: string;
  trial: TrialStatusDto;
};

export const TRIAL_UPDATED_EVENT = "gali:trial-updated";

async function readError(res: Response): Promise<string> {
  const text = await res.text();
  try {
    return (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    return text || `request -> ${res.status}`;
  }
}

export async function getAccount(): Promise<AccountDto | null> {
  const res = await authenticatedFetch("/api/me", { method: "GET" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AccountDto;
}

export async function getModelConsent(): Promise<ModelConsentDto | null> {
  const res = await authenticatedFetch("/api/consent", { method: "GET" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ModelConsentDto;
}

export async function acceptModelConsent(): Promise<ModelConsentDto> {
  const res = await authenticatedFetch("/api/consent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      voiceOpenAiAccepted: true,
      experimentsTogetherAccepted: true,
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ModelConsentDto;
}

export async function reportClientError(errorCode: string, error: Error): Promise<void> {
  const res = await authenticatedFetch("/api/client-error", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ errorCode, errorMessage: `${error.name}: ${error.message}` }),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export type ClientEvent = {
  eventName: "client.boot.completed" | "client.stream.gap";
  phase?: string;
  durationMs?: number;
  status?: string | number;
};

/** Fire-and-forget: a lost telemetry line must never disturb the app. */
export function reportClientEvent(event: ClientEvent): void {
  void authenticatedFetch("/api/client-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
    keepalive: true,
  }).catch((error: unknown) => console.warn("[telemetry] client event not delivered", error));
}

type TrialUsageReport = {
  kind: "response" | "transcription";
  externalId: string;
  usage: Record<string, unknown>;
};

const TRIAL_USAGE_QUEUE_PREFIX = "gali.trial.usage:";
let usageScope: string | null = null;
const flushingUsage = new Map<string, Promise<TrialStatusDto | null>>();

class UsageScopeChanged extends Error {}

export function setTrialUsageScope(scope: string | null): void {
  usageScope = scope?.trim().toLowerCase() || null;
}

function usageQueueKey(scope: string): string {
  return `${TRIAL_USAGE_QUEUE_PREFIX}${scope}`;
}

function isUsageReport(value: unknown): value is TrialUsageReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Partial<TrialUsageReport>;
  return (
    (report.kind === "response" || report.kind === "transcription")
    && typeof report.externalId === "string"
    && Boolean(report.externalId)
    && Boolean(report.usage)
    && typeof report.usage === "object"
    && !Array.isArray(report.usage)
  );
}

function usageQueue(scope: string): TrialUsageReport[] {
  const key = usageQueueKey(scope);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isUsageReport) : [];
  } catch {
    return [];
  }
}

function writeUsageQueue(scope: string, queue: TrialUsageReport[]): boolean {
  const key = usageQueueKey(scope);
  try {
    if (queue.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(queue));
    return true;
  } catch {
    return false;
  }
}

function sameReport(a: TrialUsageReport, b: TrialUsageReport): boolean {
  return a.kind === b.kind && a.externalId === b.externalId;
}

async function postUsage(input: TrialUsageReport, scope: string): Promise<TrialStatusDto> {
  const waits = [0, 250, 1_000];
  let failure: unknown;
  for (const wait of waits) {
    if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
    if (usageScope !== scope) throw new UsageScopeChanged();
    try {
      const res = await authenticatedFetch("/api/usage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { trial: TrialStatusDto };
      if (usageScope === scope) {
        window.dispatchEvent(new CustomEvent(TRIAL_UPDATED_EVENT, { detail: body.trial }));
      }
      return body.trial;
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

export function flushTrialUsageQueue(
  scope: string | null = usageScope,
): Promise<TrialStatusDto | null> {
  if (!scope) return Promise.resolve(null);
  const active = flushingUsage.get(scope);
  if (active) return active;
  const pending = (async () => {
    let latest: TrialStatusDto | null = null;
    for (;;) {
      if (usageScope !== scope) return latest;
      const next = usageQueue(scope)[0];
      if (!next) return latest;
      try {
        latest = await postUsage(next, scope);
      } catch (error) {
        if (error instanceof UsageScopeChanged) return latest;
        throw error;
      }
      const current = usageQueue(scope);
      writeUsageQueue(scope, current.filter((entry) => !sameReport(entry, next)));
    }
  })().finally(() => {
    flushingUsage.delete(scope);
  });
  flushingUsage.set(scope, pending);
  return pending;
}

export async function reportTrialUsage(input: TrialUsageReport): Promise<TrialStatusDto | null> {
  let scope = usageScope;
  if (!scope) {
    const account = await getAccount();
    if (!account) throw new Error("trial usage account is not ready");
    setTrialUsageScope(account.identityEmail);
    scope = usageScope;
  }
  if (!scope) throw new Error("trial usage account is not ready");
  const queue = usageQueue(scope);
  if (!queue.some((entry) => sameReport(entry, input))) {
    const stored = writeUsageQueue(scope, [...queue, input]);
    if (!stored) return postUsage(input, scope);
  }
  return flushTrialUsageQueue(scope);
}
