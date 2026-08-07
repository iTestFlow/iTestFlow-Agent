import type { ExecutionOutcome, RunOutcome } from "./run-state";

/**
 * Pure outcome rollups: step outcomes → case outcome → run outcome. Step
 * outcomes are produced by the agentic step executor (verdicts, budgets,
 * blocked reasons); this module only aggregates them.
 */

/** Step outcomes that allow the case to continue to the next step. */
export function stepOutcomeContinuesCase(outcome: ExecutionOutcome): boolean {
  return outcome === "passed";
}

/**
 * Case rollup: the first non-passed step decides the case outcome; all steps
 * after it are not_run. An empty list (never executed) is not_run.
 */
export function rollUpCaseOutcome(stepOutcomes: readonly ExecutionOutcome[]): ExecutionOutcome {
  if (stepOutcomes.length === 0) return "not_run";
  for (const outcome of stepOutcomes) {
    if (outcome !== "passed") return outcome;
  }
  return "passed";
}

/**
 * Run rollup precedence: infrastructure problems dominate (the run is not
 * trustworthy), then timeouts, then real test failures, then blocks, then
 * anything needing human review. canceled is decided by the cancel path, not
 * by rollup.
 */
const RUN_ROLLUP_PRECEDENCE: readonly { outcome: RunOutcome; matches: readonly ExecutionOutcome[] }[] = [
  { outcome: "infrastructure_error", matches: ["infrastructure_error"] },
  { outcome: "timeout", matches: ["timeout"] },
  { outcome: "failed", matches: ["failed_assertion"] },
  { outcome: "blocked", matches: ["blocked_policy", "blocked_prerequisite"] },
  { outcome: "needs_review", matches: ["needs_review"] },
];

export function rollUpRunOutcome(caseOutcomes: readonly ExecutionOutcome[]): RunOutcome {
  if (caseOutcomes.includes("canceled")) return "canceled";
  for (const rule of RUN_ROLLUP_PRECEDENCE) {
    if (caseOutcomes.some((outcome) => rule.matches.includes(outcome))) {
      return rule.outcome;
    }
  }
  return "passed";
}

export type RunSummary = {
  caseCounts: Partial<Record<ExecutionOutcome, number>>;
  totalCases: number;
  executedCases: number;
};

export function buildRunSummary(caseOutcomes: readonly ExecutionOutcome[]): RunSummary {
  const caseCounts: Partial<Record<ExecutionOutcome, number>> = {};
  let executedCases = 0;
  for (const outcome of caseOutcomes) {
    caseCounts[outcome] = (caseCounts[outcome] ?? 0) + 1;
    if (outcome !== "not_run" && outcome !== "skipped") executedCases += 1;
  }
  return { caseCounts, totalCases: caseOutcomes.length, executedCases };
}
