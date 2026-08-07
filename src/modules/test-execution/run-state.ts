/**
 * Test Execution state machine — pure transition rules shared by services,
 * SQL guards, and the worker handler.
 *
 * Job lifecycle (jobs table) is deliberately separate from these states: a
 * failed *test* is a completed *job*. Run/case/step statuses describe where
 * execution is; outcomes describe what the test concluded and exist only on
 * terminal rows (enforced by CHECK constraints in 1710000038000).
 */

export const RUN_STATUSES = ["queued", "running", "completed", "canceled", "error"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_OUTCOMES = [
  "passed",
  "failed",
  "blocked",
  "infrastructure_error",
  "timeout",
  "canceled",
  "needs_review",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export const EXECUTION_STATUSES = ["pending", "running", "completed"] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const EXECUTION_OUTCOMES = [
  "passed",
  "failed_assertion",
  "blocked_policy",
  "blocked_prerequisite",
  "infrastructure_error",
  "timeout",
  "canceled",
  "skipped",
  "not_run",
  "needs_review",
] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "canceled", "error"],
  running: ["completed", "canceled", "error"],
  completed: [],
  canceled: [],
  error: [],
};

/**
 * pending → completed (without running) covers cases/steps finalized as
 * not_run/canceled/skipped when execution never reached them.
 */
const EXECUTION_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  pending: ["running", "completed"],
  running: ["completed"],
  completed: [],
};

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return RUN_TRANSITIONS[from].includes(to);
}

export function canTransitionExecution(from: ExecutionStatus, to: ExecutionStatus): boolean {
  return EXECUTION_TRANSITIONS[from].includes(to);
}

export function isTerminalRunStatus(status: RunStatus): boolean {
  return RUN_TRANSITIONS[status].length === 0;
}

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return status === "completed";
}

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

export function isExecutionOutcome(value: string): value is ExecutionOutcome {
  return (EXECUTION_OUTCOMES as readonly string[]).includes(value);
}
