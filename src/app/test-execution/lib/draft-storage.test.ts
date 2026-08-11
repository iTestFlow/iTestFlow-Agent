// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearDraft,
  loadActiveRunId,
  loadDraft,
  saveActiveRunId,
  saveDraft,
} from "./draft-storage";

const draft = {
  storyWorkItemId: "123",
  storyTitle: "Story",
  environmentProfileId: null,
  cases: [
    {
      title: "Case",
      sourceKind: "manual" as const,
      azureTestCaseId: null,
      plan: {
        schemaVersion: "v2-natural" as const,
        steps: [{ instruction: "Open the dashboard", expectedResult: "", layerHint: "auto" as const }],
      },
    },
  ],
};

describe("draft storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a draft per project", () => {
    saveDraft("proj-a", draft);
    expect(loadDraft("proj-a")?.storyWorkItemId).toBe("123");
    expect(loadDraft("proj-b")).toBeNull();
    clearDraft("proj-a");
    expect(loadDraft("proj-a")).toBeNull();
  });

  it("normalizes pre-layer-hint v2 drafts to Auto", () => {
    window.localStorage.setItem(
      "itestflow.testExecution.draft.proj-a",
      JSON.stringify({
        ...draft,
        version: 2,
        savedAt: new Date().toISOString(),
        cases: [{ ...draft.cases[0], plan: { ...draft.cases[0].plan, steps: [{ instruction: "Legacy", expectedResult: "" }] } }],
      }),
    );
    expect(loadDraft("proj-a")?.cases[0].plan.steps[0].layerHint).toBe("auto");
  });

  it("rejects corrupt, versionless, or old-version payloads instead of crashing", () => {
    window.localStorage.setItem("itestflow.testExecution.draft.proj-a", "{not json");
    expect(loadDraft("proj-a")).toBeNull();
    window.localStorage.setItem("itestflow.testExecution.draft.proj-a", JSON.stringify({ version: 99 }));
    expect(loadDraft("proj-a")).toBeNull();
    // Phase 1 typed drafts (v1) are deliberately discarded after the agentic redesign.
    window.localStorage.setItem(
      "itestflow.testExecution.draft.proj-a",
      JSON.stringify({ version: 1, cases: [] }),
    );
    expect(loadDraft("proj-a")).toBeNull();
  });

  it("tracks the active run id per project", () => {
    saveActiveRunId("proj-a", "trun_1");
    expect(loadActiveRunId("proj-a")).toBe("trun_1");
    saveActiveRunId("proj-a", null);
    expect(loadActiveRunId("proj-a")).toBeNull();
  });
});
