import { describe, expect, it } from "vitest";

import {
  EXECUTION_STATUSES,
  RUN_STATUSES,
  canTransitionExecution,
  canTransitionRun,
  isExecutionOutcome,
  isRunStatus,
  isTerminalExecutionStatus,
  isTerminalRunStatus,
} from "./run-state";

describe("run transitions", () => {
  it("allows the documented forward paths", () => {
    expect(canTransitionRun("queued", "running")).toBe(true);
    expect(canTransitionRun("queued", "canceled")).toBe(true);
    expect(canTransitionRun("queued", "error")).toBe(true);
    expect(canTransitionRun("running", "completed")).toBe(true);
    expect(canTransitionRun("running", "canceled")).toBe(true);
    expect(canTransitionRun("running", "error")).toBe(true);
  });

  it("rejects backward and terminal-origin transitions", () => {
    expect(canTransitionRun("running", "queued")).toBe(false);
    expect(canTransitionRun("queued", "completed")).toBe(false);
    for (const from of ["completed", "canceled", "error"] as const) {
      for (const to of RUN_STATUSES) {
        expect(canTransitionRun(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it("marks exactly completed/canceled/error as terminal", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("canceled")).toBe(true);
    expect(isTerminalRunStatus("error")).toBe(true);
  });
});

describe("case/step transitions", () => {
  it("allows pending→running→completed and the pending→completed shortcut", () => {
    expect(canTransitionExecution("pending", "running")).toBe(true);
    expect(canTransitionExecution("running", "completed")).toBe(true);
    expect(canTransitionExecution("pending", "completed")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(canTransitionExecution("running", "pending")).toBe(false);
    for (const to of EXECUTION_STATUSES) {
      expect(canTransitionExecution("completed", to), `completed -> ${to}`).toBe(false);
    }
  });

  it("only completed is terminal", () => {
    expect(isTerminalExecutionStatus("pending")).toBe(false);
    expect(isTerminalExecutionStatus("running")).toBe(false);
    expect(isTerminalExecutionStatus("completed")).toBe(true);
  });
});

describe("string guards", () => {
  it("isRunStatus accepts only run statuses", () => {
    expect(isRunStatus("running")).toBe(true);
    expect(isRunStatus("passed")).toBe(false);
  });

  it("isExecutionOutcome accepts the full 10-value taxonomy and nothing else", () => {
    for (const outcome of [
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
    ]) {
      expect(isExecutionOutcome(outcome), outcome).toBe(true);
    }
    expect(isExecutionOutcome("failed")).toBe(false);
  });
});
