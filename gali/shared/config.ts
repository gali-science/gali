// Product settings: identical for web and every sandbox, and not
// secret. Secrets and per-deployment URLs stay in env.
export const GALI_CONFIG = {
  realtime: {
    model: "gpt-realtime-2.1",
    voice: "marin",
    vadEagerness: "medium",
    noiseReduction: "far_field",
    transcribeModel: "gpt-transcribe",
    reasoningEffort: "low",
  },
  codexModel: "gpt-6.1-sol",
  fastModel: "gpt-6-luna",
  // Where every account's sandbox lives. An account on another provider is
  // moved here on its next request and starts from a blank starter.
  sandboxProvider: "vercel",
  sandboxIdleMinutes: 15,
  // One review turn is aborted past this.
  reviewTurnMinutes: 30,
  // The background review subagent is interrupted past this.
  reviewSubagentMinutes: 90,
  // A paper's reviewer process stops after this long with nothing running.
  reviewerIdleMinutes: 15,
  // A running reviewer's progress line is redrawn this often, when it did something new.
  reviewProgressSeconds: 10,
  trialBudgetUsd: 100,
} as const;
