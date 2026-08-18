import { describe, expect, it } from "vitest";
import {
  applyProfileToDraft,
  caseIsReady,
  createEmptyDraft,
  draftFromRunDetail,
  draftHasContent,
  draftIssues,
  isValidHttpUrl,
  mergeImportedCases,
  newManualCase,
  testDataIssues,
  type ExecutionDraft,
} from "./execution-draft";

function executableDraft(): ExecutionDraft {
  const draft = createEmptyDraft();
  draft.setup.baseUrl = "https://app.example.com";
  draft.cases = mergeImportedCases([], [{
    title: "Login works", steps: [{ action: "Open the app", expectedResult: "Login page shows" }], source: "manual",
  }]);
  return draft;
}

describe("draft basics", () => {
  it("validates http(s) URLs and rejects credentials and other schemes", () => {
    expect(isValidHttpUrl("https://app.example.com/login")).toBe(true);
    expect(isValidHttpUrl("http://localhost:3000")).toBe(true);
    expect(isValidHttpUrl("ftp://example.com")).toBe(false);
    expect(isValidHttpUrl("https://user:pw@example.com")).toBe(false);
    expect(isValidHttpUrl("not a url")).toBe(false);
  });

  it("seeds a manual case with one empty step and a numbered title", () => {
    const manual = newManualCase(2);
    expect(manual.title).toBe("Manual case 3");
    expect(manual.steps).toHaveLength(1);
    expect(manual.source).toBe("manual");
    expect(caseIsReady(manual)).toBe(false);
  });

  it("deduplicates imports by test case + point identity", () => {
    const first = mergeImportedCases([], [
      { azureTestCaseId: 1, azureTestPointId: 10, azurePlanId: 5, azureSuiteId: 6, title: "A", steps: [{ action: "Do" }], source: "plan-suite" },
      { azureTestCaseId: 2, title: "B", steps: [{ action: "Do" }], source: "user-story" },
    ]);
    const merged = mergeImportedCases(first, [
      { azureTestCaseId: 1, azureTestPointId: 10, azurePlanId: 5, azureSuiteId: 6, title: "A again", steps: [{ action: "Do" }], source: "plan-suite" },
      { azureTestCaseId: 2, azureTestPointId: 20, azurePlanId: 5, azureSuiteId: 6, title: "B with point", steps: [{ action: "Do" }], source: "plan-suite" },
    ]);
    expect(merged).toHaveLength(3);
  });
});

describe("draftIssues", () => {
  it("is empty for a runnable draft", () => {
    expect(draftIssues(executableDraft())).toEqual([]);
  });

  it("flags missing base URL, missing cases, and unready cases", () => {
    const draft = createEmptyDraft();
    draft.cases = [newManualCase(0)];
    const issues = draftIssues(draft);
    expect(issues.join(" ")).toMatch(/Base URL/);
    expect(issues.join(" ")).toMatch(/needs a title and at least one step/);
  });

  it("flags secret rows with neither a value nor a saved reference, and duplicate titles", () => {
    const draft = executableDraft();
    draft.setup.testData = [
      { localId: "1", title: "Password", isSecret: true, value: "" },
      { localId: "2", title: "password", isSecret: true, value: "x" },
      { localId: "3", title: "", isSecret: false, value: "" },
    ];
    const issues = draftIssues(draft);
    expect(issues.join(" ")).toMatch(/Enter a value for "Password"/);
    expect(issues.join(" ")).toMatch(/unique/);
    expect(issues.join(" ")).not.toMatch(/needs a title\./);
  });

  it("accepts an untouched saved secret as complete", () => {
    const draft = executableDraft();
    draft.setup.testData = [
      { localId: "1", title: "Password", isSecret: true, value: "", savedRef: { kind: "run", id: "run-1", title: "Password" } },
    ];
    expect(draftIssues(draft)).toEqual([]);
  });

  it("mirrors the API caps so the review step blocks before a server 400", () => {
    const overCases = executableDraft();
    overCases.cases = Array.from({ length: 201 }, (_, index) => ({
      localId: `c${index}`, source: "manual" as const, title: `Case ${index}`,
      steps: [{ localId: `s${index}`, action: "Do", expectedResult: "" }],
    }));
    expect(draftIssues(overCases).join(" ")).toMatch(/limited to 200 test cases/);

    const overSteps = executableDraft();
    overSteps.cases[0].steps = Array.from({ length: 101 }, (_, index) => ({ localId: `s${index}`, action: "Do", expectedResult: "" }));
    expect(draftIssues(overSteps).join(" ")).toMatch(/limit is 100 per case/);

    const overText = executableDraft();
    overText.cases[0].steps[0].action = "x".repeat(4001);
    expect(draftIssues(overText).join(" ")).toMatch(/longer than 4000 characters/);
  });

  it("detects whether a draft carries authored content worth confirming before overwrite", () => {
    expect(draftHasContent(createEmptyDraft())).toBe(false);
    expect(draftHasContent(executableDraft())).toBe(true);
    const dataOnly = createEmptyDraft();
    dataOnly.setup.testData = [{ localId: "1", title: "Username", isSecret: false, value: "" }];
    expect(draftHasContent(dataOnly)).toBe(true);
  });

  it("exposes test-data issues standalone for profile saves", () => {
    expect(testDataIssues([{ localId: "1", title: "Username", isSecret: false, value: "" }]).join(" ")).toMatch(/Enter a value for "Username"/);
    expect(testDataIssues([])).toEqual([]);
  });
});

describe("rerun and profile prefill", () => {
  it("rebuilds an editable draft from a finished run with masked secrets", () => {
    const draft = draftFromRunDetail({
      id: "run-9",
      baseUrl: "https://app.example.com",
      executionNotes: "Use the staging tenant.",
      screenshotPolicy: "every-step",
      azurePlanId: 5,
      azureSuiteId: 6,
      testData: [
        { title: "Username", isSecret: false, value: "qa@example.com" },
        { title: "Password", isSecret: true, value: null },
      ],
      cases: [
        { azureTestCaseId: 1, azureTestPointId: 10, azurePlanId: 5, azureSuiteId: 6, title: "Imported", steps: [{ action: "Open", expectedResult: "Loads" }] },
        { azureTestCaseId: 2, azureTestPointId: null, title: "From story", steps: [{ action: "Open", expectedResult: null }] },
        { azureTestCaseId: null, azureTestPointId: null, title: "Manual", steps: [] },
      ],
    });
    expect(draft.setup.baseUrl).toBe("https://app.example.com");
    expect(draft.setup.screenshotPolicy).toBe("every-step");
    expect(draft.setup.testData[0]).toMatchObject({ title: "Username", value: "qa@example.com" });
    expect(draft.setup.testData[1]).toMatchObject({ title: "Password", value: "", savedRef: { kind: "run", id: "run-9", title: "Password" } });
    expect(draft.cases.map((testCase) => testCase.source)).toEqual(["plan-suite", "user-story", "manual"]);
    expect(draft.cases[0]).toMatchObject({ azureTestCaseId: 1, azureTestPointId: 10, azurePlanId: 5, azureSuiteId: 6 });
    expect(draft.cases[2].steps).toHaveLength(1);
    expect(draft.provenance).toEqual({ planId: 5, suiteId: 6 });
    expect(draftIssues(draft)).toContain("1 test case needs a title and at least one step with an instruction.");
  });

  it("falls back to run-level plan/suite ids for legacy point-carrying cases", () => {
    const draft = draftFromRunDetail({
      id: "run-legacy",
      baseUrl: null,
      executionNotes: null,
      screenshotPolicy: "validation-points",
      azurePlanId: 5,
      azureSuiteId: 6,
      cases: [
        { azureTestCaseId: 1, azureTestPointId: 10, azurePlanId: null, azureSuiteId: null, title: "Legacy", steps: [{ action: "Open", expectedResult: null }] },
        { azureTestCaseId: 2, azureTestPointId: null, azurePlanId: null, azureSuiteId: null, title: "Story", steps: [{ action: "Open", expectedResult: null }] },
      ],
    });
    expect(draft.cases[0]).toMatchObject({ azurePlanId: 5, azureSuiteId: 6 });
    expect(draft.cases[1].azurePlanId).toBeUndefined();
  });

  it("applies a profile to the setup without touching the case list", () => {
    const draft = executableDraft();
    const applied = applyProfileToDraft(draft, {
      id: "prof-1",
      baseUrl: "https://staging.example.com",
      executionNotes: null,
      screenshotPolicy: "failures-only",
      testData: [{ title: "Password", isSecret: true, value: null }],
    });
    expect(applied.setup.profileId).toBe("prof-1");
    expect(applied.setup.baseUrl).toBe("https://staging.example.com");
    expect(applied.setup.testData[0].savedRef).toEqual({ kind: "profile", id: "prof-1", title: "Password" });
    expect(applied.cases).toBe(draft.cases);
  });
});
