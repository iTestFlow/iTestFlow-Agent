import { describe, expect, it } from "vitest";

import { deriveStepperState, isTerminalRunStatusValue, stepperLocked } from "./stepper-gating";
import { runPollDelay } from "./run-polling";

describe("deriveStepperState", () => {
  it("starts with only the environment step enabled", () => {
    const state = deriveStepperState({ environmentReady: false, caseCount: 0, runId: null, runTerminal: false });
    expect(state.enabledStepIds).toEqual(["environment"]);
    expect(state.completedStepIds).toEqual([]);
  });

  it("unlocks scope after environment and review after cases", () => {
    expect(
      deriveStepperState({ environmentReady: true, caseCount: 0, runId: null, runTerminal: false }).enabledStepIds,
    ).toEqual(["environment", "scope"]);
    expect(
      deriveStepperState({ environmentReady: true, caseCount: 2, runId: null, runTerminal: false }).enabledStepIds,
    ).toEqual(["environment", "scope", "review"]);
  });

  it("unlocks results once a run exists and marks review completed", () => {
    const state = deriveStepperState({ environmentReady: true, caseCount: 2, runId: "trun_1", runTerminal: true });
    expect(state.enabledStepIds).toContain("results");
    expect(state.completedStepIds).toEqual(["environment", "scope", "review"]);
  });
});

describe("stepperLocked", () => {
  it("locks navigation only while a run is live", () => {
    expect(stepperLocked({ environmentReady: true, caseCount: 1, runId: "trun_1", runTerminal: false })).toBe(true);
    expect(stepperLocked({ environmentReady: true, caseCount: 1, runId: "trun_1", runTerminal: true })).toBe(false);
    expect(stepperLocked({ environmentReady: true, caseCount: 1, runId: null, runTerminal: false })).toBe(false);
  });
});

describe("isTerminalRunStatusValue", () => {
  it("recognizes exactly the terminal statuses", () => {
    expect(isTerminalRunStatusValue("completed")).toBe(true);
    expect(isTerminalRunStatusValue("canceled")).toBe(true);
    expect(isTerminalRunStatusValue("error")).toBe(true);
    expect(isTerminalRunStatusValue("running")).toBe(false);
    expect(isTerminalRunStatusValue(null)).toBe(false);
  });
});

describe("runPollDelay", () => {
  it("polls fast early, then relaxes", () => {
    expect(runPollDelay(1_000, 0)).toBe(2_000);
    expect(runPollDelay(60_000, 0)).toBe(5_000);
    expect(runPollDelay(10 * 60_000, 0)).toBe(15_000);
  });

  it("backs off on consecutive failures", () => {
    expect(runPollDelay(1_000, 1)).toBe(5_000);
    expect(runPollDelay(1_000, 2)).toBe(15_000);
    expect(runPollDelay(1_000, 9)).toBe(30_000);
  });
});
