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

export type StepNavTargets = {
  backTarget: ExecutionStepId | null;
  nextTarget: ExecutionStepId | null;
  nextEnabled: boolean;
};

/**
 * Bottom-of-step navigation targets. Next only exists for setup/cases — the
 * review step's primary action is Approve & Execute, and results is reached
 * through a finished run. Back lands on the nearest *enabled* earlier step,
 * so a cleared draft never strands the user on a disabled target.
 */
export function stepNavTargets(activeStep: ExecutionStepId, enabledStepIds: ExecutionStepId[]): StepNavTargets {
  const order = EXECUTION_STEPS.map((step) => step.id);
  const index = order.indexOf(activeStep);
  const backTarget = order.slice(0, Math.max(index, 0)).reverse().find((id) => enabledStepIds.includes(id)) ?? null;
  const nextTarget = activeStep === "setup" ? "cases" : activeStep === "cases" ? "review" : null;
  return { backTarget, nextTarget, nextEnabled: nextTarget !== null && enabledStepIds.includes(nextTarget) };
}
