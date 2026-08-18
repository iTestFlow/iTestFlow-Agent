import type { ExecutionDraft } from "./execution-draft";
import { caseIsReady, draftIssues } from "./execution-draft";

export const EXECUTION_STEPS = [
  { id: "setup", label: "Setup", shortLabel: "Setup", description: "Base URL, screenshots, test data, and instructions" },
  { id: "cases", label: "Test Cases", shortLabel: "Cases", description: "Import, write, and edit the cases to run" },
  { id: "review", label: "Review & Execute", shortLabel: "Execute", description: "Approve the plan and watch it run" },
  { id: "results", label: "Results", shortLabel: "Results", description: "Outcomes, evidence, and publishing" },
] as const;

export type ExecutionStepId = (typeof EXECUTION_STEPS)[number]["id"];

export type StepperState = {
  enabledStepIds: ExecutionStepId[];
  completedStepIds: ExecutionStepId[];
  /** True while a run is queued/running — the stepper becomes a status row. */
  locked: boolean;
};

export function isTerminalRunStatus(status: string): boolean {
  return !["queued", "running"].includes(status);
}

export function draftIsExecutable(draft: ExecutionDraft): boolean {
  return draftIssues(draft).length === 0 && draft.cases.length > 0;
}

/**
 * Pure derivation of the stepper's enabled/completed sets. While a run is
 * live the workflow is pinned to the review step (live progress in place);
 * otherwise navigation is gated only by whether the draft can actually run.
 */
export function deriveStepperState(input: {
  draft: ExecutionDraft;
  liveRunActive: boolean;
  hasViewedRun: boolean;
}): StepperState {
  if (input.liveRunActive) {
    return { enabledStepIds: ["review"], completedStepIds: completedSteps(input), locked: true };
  }
  const enabled: ExecutionStepId[] = ["setup", "cases"];
  if (draftIsExecutable(input.draft)) enabled.push("review");
  if (input.hasViewedRun) enabled.push("results");
  return { enabledStepIds: enabled, completedStepIds: completedSteps(input), locked: false };
}

function completedSteps(input: { draft: ExecutionDraft; hasViewedRun: boolean }): ExecutionStepId[] {
  const completed: ExecutionStepId[] = [];
  const issues = draftIssues(input.draft);
  const baseUrlOk = !issues.some((issue) => issue.includes("Base URL"));
  if (input.draft.setup.baseUrl.trim() && baseUrlOk) completed.push("setup");
  if (input.draft.cases.length > 0 && input.draft.cases.every(caseIsReady)) completed.push("cases");
  if (input.hasViewedRun) completed.push("review");
  return completed;
}
