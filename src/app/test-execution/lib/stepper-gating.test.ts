import { describe, expect, it } from "vitest";
import { createEmptyDraft, mergeImportedCases, type ExecutionDraft } from "./execution-draft";
import { EXECUTION_STEPS, deriveStepperState, draftIsExecutable, isTerminalRunStatus, stepNavTargets } from "./stepper-gating";

function executableDraft(): ExecutionDraft {
  const draft = createEmptyDraft();
  draft.setup.baseUrl = "https://app.example.com";
  draft.cases = mergeImportedCases([], [{ title: "Case", steps: [{ action: "Do" }], source: "manual" }]);
  return draft;
}

describe("stepper gating", () => {
  it("defines the four workbench steps in order", () => {
    expect(EXECUTION_STEPS.map((step) => step.id)).toEqual(["setup", "cases", "review", "results"]);
  });

  it("keeps review locked until the draft can actually run", () => {
    const empty = deriveStepperState({ draft: createEmptyDraft(), liveRunActive: false, hasViewedRun: false });
    expect(empty.enabledStepIds).toEqual(["setup", "cases"]);
    expect(empty.completedStepIds).toEqual([]);
    expect(empty.locked).toBe(false);

    const ready = deriveStepperState({ draft: executableDraft(), liveRunActive: false, hasViewedRun: false });
    expect(ready.enabledStepIds).toEqual(["setup", "cases", "review"]);
    expect(ready.completedStepIds).toEqual(["setup", "cases"]);
  });

  it("pins the workflow to review while a run is live", () => {
    const state = deriveStepperState({ draft: executableDraft(), liveRunActive: true, hasViewedRun: false });
    expect(state.locked).toBe(true);
    expect(state.enabledStepIds).toEqual(["review"]);
  });

  it("unlocks results once a run has been viewed or created", () => {
    const state = deriveStepperState({ draft: executableDraft(), liveRunActive: false, hasViewedRun: true });
    expect(state.enabledStepIds).toContain("results");
    expect(state.completedStepIds).toContain("review");
  });

  it("exposes executable and terminal-status helpers", () => {
    expect(draftIsExecutable(createEmptyDraft())).toBe(false);
    expect(draftIsExecutable(executableDraft())).toBe(true);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("queued")).toBe(false);
    for (const status of ["passed", "failed", "blocked", "timeout", "cancelled", "error"]) {
      expect(isTerminalRunStatus(status)).toBe(true);
    }
  });

  it("derives bottom-nav targets: forward only for setup/cases, gated by enablement", () => {
    expect(stepNavTargets("setup", ["setup", "cases"])).toEqual({ backTarget: null, nextTarget: "cases", nextEnabled: true });
    expect(stepNavTargets("cases", ["setup", "cases"])).toEqual({ backTarget: "setup", nextTarget: "review", nextEnabled: false });
    expect(stepNavTargets("cases", ["setup", "cases", "review"])).toEqual({ backTarget: "setup", nextTarget: "review", nextEnabled: true });
    expect(stepNavTargets("review", ["setup", "cases", "review"])).toEqual({ backTarget: "cases", nextTarget: null, nextEnabled: false });
    expect(stepNavTargets("results", ["setup", "cases", "results"])).toEqual({ backTarget: "cases", nextTarget: null, nextEnabled: false });
  });

  it("routes Back to the nearest enabled earlier step when review is disabled", () => {
    // After a run the draft is cleared, so review drops out of the enabled set.
    expect(stepNavTargets("results", ["setup", "cases", "results"]).backTarget).toBe("cases");
    expect(stepNavTargets("cases", ["cases"]).backTarget).toBeNull();
  });
});
