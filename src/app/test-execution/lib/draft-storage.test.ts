// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyDraft, mergeImportedCases } from "./execution-draft";
import { clearDraft, loadDraft, saveDraft } from "./draft-storage";

const projectId = "project-1";

function sampleDraft() {
  const draft = createEmptyDraft();
  draft.setup.baseUrl = "https://app.example.com";
  draft.setup.testData = [
    { localId: "1", title: "Username", isSecret: false, value: "qa@example.com" },
    { localId: "2", title: "Password", isSecret: true, value: "TypedButNotRun!" },
    { localId: "3", title: "OTP", isSecret: true, value: "", savedRef: { kind: "run", id: "run-1", title: "OTP" } },
  ];
  draft.cases = mergeImportedCases([], [{ title: "Case", steps: [{ action: "Do" }], source: "manual" }]);
  return draft;
}

describe("draft storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("round-trips a draft but strips typed secret values", () => {
    saveDraft(projectId, sampleDraft());
    const loaded = loadDraft(projectId);
    expect(loaded?.setup.baseUrl).toBe("https://app.example.com");
    expect(loaded?.cases).toHaveLength(1);
    expect(loaded?.setup.testData.map((entry) => entry.value)).toEqual(["qa@example.com", "", ""]);
    expect(loaded?.setup.testData[2].savedRef).toEqual({ kind: "run", id: "run-1", title: "OTP" });
    expect(window.localStorage.getItem(`itestflow.testExecution.draft.${projectId}`)).not.toContain("TypedButNotRun!");
  });

  it("scopes drafts per project", () => {
    saveDraft(projectId, sampleDraft());
    expect(loadDraft("other-project")).toBeNull();
  });

  it("discards unknown versions and corrupted payloads", () => {
    window.localStorage.setItem(`itestflow.testExecution.draft.${projectId}`, JSON.stringify({ version: 99, draft: {} }));
    expect(loadDraft(projectId)).toBeNull();
    window.localStorage.setItem(`itestflow.testExecution.draft.${projectId}`, "{not json");
    expect(loadDraft(projectId)).toBeNull();
  });

  it("clears saved drafts", () => {
    saveDraft(projectId, sampleDraft());
    clearDraft(projectId);
    expect(loadDraft(projectId)).toBeNull();
  });
});
