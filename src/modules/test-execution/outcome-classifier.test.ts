import { describe, expect, it } from "vitest";

import {
  buildRunSummary,
  rollUpCaseOutcome,
  rollUpRunOutcome,
  stepOutcomeContinuesCase,
} from "./outcome-classifier";

describe("stepOutcomeContinuesCase", () => {
  it("continues only after a pass", () => {
    expect(stepOutcomeContinuesCase("passed")).toBe(true);
    expect(stepOutcomeContinuesCase("failed_assertion")).toBe(false);
    expect(stepOutcomeContinuesCase("needs_review")).toBe(false);
    expect(stepOutcomeContinuesCase("timeout")).toBe(false);
  });
});

describe("rollUpCaseOutcome", () => {
  it("passes only when every step passed", () => {
    expect(rollUpCaseOutcome(["passed", "passed", "passed"])).toBe("passed");
  });

  it("takes the first non-passed step's outcome", () => {
    expect(rollUpCaseOutcome(["passed", "failed_assertion", "passed"])).toBe("failed_assertion");
    expect(rollUpCaseOutcome(["blocked_prerequisite", "failed_assertion"])).toBe("blocked_prerequisite");
    expect(rollUpCaseOutcome(["passed", "canceled"])).toBe("canceled");
  });

  it("treats an empty step list as not_run", () => {
    expect(rollUpCaseOutcome([])).toBe("not_run");
  });
});

describe("rollUpRunOutcome", () => {
  it("returns passed for all-passed", () => {
    expect(rollUpRunOutcome(["passed", "passed"])).toBe("passed");
  });

  it("applies severity precedence", () => {
    expect(rollUpRunOutcome(["passed", "failed_assertion", "infrastructure_error"])).toBe(
      "infrastructure_error",
    );
    expect(rollUpRunOutcome(["timeout", "failed_assertion"])).toBe("timeout");
    expect(rollUpRunOutcome(["failed_assertion", "blocked_policy", "needs_review"])).toBe("failed");
    expect(rollUpRunOutcome(["blocked_prerequisite", "needs_review", "passed"])).toBe("blocked");
    expect(rollUpRunOutcome(["needs_review", "passed"])).toBe("needs_review");
  });

  it("canceled dominates everything", () => {
    expect(rollUpRunOutcome(["infrastructure_error", "canceled"])).toBe("canceled");
  });

  it("skipped/not_run alone still count as passed run", () => {
    expect(rollUpRunOutcome(["passed", "skipped", "not_run"])).toBe("passed");
  });
});

describe("buildRunSummary", () => {
  it("counts case outcomes and executed cases", () => {
    const summary = buildRunSummary(["passed", "passed", "failed_assertion", "not_run", "skipped"]);
    expect(summary.totalCases).toBe(5);
    expect(summary.executedCases).toBe(3);
    expect(summary.caseCounts.passed).toBe(2);
    expect(summary.caseCounts.failed_assertion).toBe(1);
  });
});
