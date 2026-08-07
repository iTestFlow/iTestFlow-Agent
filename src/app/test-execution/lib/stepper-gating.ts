/**
 * Pure stepper gating for the Test Execution page. Free navigation while
 * drafting; once a run exists the stepper becomes job-driven (the client
 * renders it read-only until the run reaches a terminal state).
 */

export const TEST_EXECUTION_STEPS = [
  { id: "environment", label: "Environment", shortLabel: "Env" },
  { id: "scope", label: "Test Scope", shortLabel: "Scope" },
  { id: "review", label: "Review & Execute", shortLabel: "Execute" },
  { id: "results", label: "Results & Report", shortLabel: "Results" },
] as const;

export type TestExecutionStepId = (typeof TEST_EXECUTION_STEPS)[number]["id"];

export type StepperInputs = {
  environmentReady: boolean;
  caseCount: number;
  runId: string | null;
  runTerminal: boolean;
};

export function deriveStepperState(input: StepperInputs): {
  completedStepIds: TestExecutionStepId[];
  enabledStepIds: TestExecutionStepId[];
} {
  const completed: TestExecutionStepId[] = [];
  if (input.environmentReady) completed.push("environment");
  if (input.caseCount > 0) completed.push("scope");
  if (input.runId) completed.push("review");

  const enabled: TestExecutionStepId[] = ["environment"];
  if (input.environmentReady) enabled.push("scope");
  if (input.environmentReady && input.caseCount > 0) enabled.push("review");
  if (input.runId) enabled.push("results");
  return { completedStepIds: completed, enabledStepIds: enabled };
}

/** While a run is queued/running the stepper is read-only on the review step. */
export function stepperLocked(input: StepperInputs): boolean {
  return Boolean(input.runId) && !input.runTerminal;
}

export function isTerminalRunStatusValue(status: string | null | undefined): boolean {
  return status === "completed" || status === "canceled" || status === "error";
}
