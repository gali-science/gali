import { expect, test } from "vitest";
import { GALI_CONFIG } from "../../../shared/config.js";
import { trialStatus } from "./trial.js";

const budgetMicros = GALI_CONFIG.trialBudgetUsd * 1_000_000;

test("reports the remaining configured budget", () => {
  expect(trialStatus({ trialSpentMicros: budgetMicros / 4 })).toEqual({
    status: "active",
    spentUsd: GALI_CONFIG.trialBudgetUsd / 4,
    budgetUsd: GALI_CONFIG.trialBudgetUsd,
    remainingUsd: (GALI_CONFIG.trialBudgetUsd * 3) / 4,
  });
});

test("marks the trial exhausted at the configured budget", () => {
  expect(trialStatus({ trialSpentMicros: budgetMicros })).toEqual({
    status: "exhausted",
    spentUsd: GALI_CONFIG.trialBudgetUsd,
    budgetUsd: GALI_CONFIG.trialBudgetUsd,
    remainingUsd: 0,
  });
});
