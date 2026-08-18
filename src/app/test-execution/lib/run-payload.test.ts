import { describe, expect, it } from "vitest";
import type { ActiveProjectScope } from "@/shared/lib/active-project";
import { createEmptyDraft, mergeImportedCases } from "./execution-draft";
import { draftToRunRequest, setupToProfileRequest, testDataToPayload } from "./run-payload";

const scope: ActiveProjectScope = {
  workspaceId: "w", projectId: "p", azureProjectId: "ap", azureProjectName: "P", azureOrganizationUrl: "https://dev.azure.com/o",
};

describe("testDataToPayload", () => {
  it("prunes blank rows and maps typed values and saved references", () => {
    expect(testDataToPayload([
      { localId: "0", title: "", isSecret: false, value: "" },
      { localId: "1", title: "Username", isSecret: false, value: "qa@example.com" },
      { localId: "2", title: "Password", isSecret: true, value: "Typed!New" },
      { localId: "3", title: "OTP seed", isSecret: true, value: "", savedRef: { kind: "run", id: "run-1", title: "OTP seed" } },
      { localId: "4", title: "Admin password", isSecret: true, value: "", savedRef: { kind: "profile", id: "prof-1", title: "Password" } },
    ])).toEqual([
      { title: "Username", isSecret: false, value: "qa@example.com" },
      { title: "Password", isSecret: true, value: "Typed!New" },
      { title: "OTP seed", isSecret: true, fromRunId: "run-1" },
      { title: "Admin password", isSecret: true, fromProfileId: "prof-1", sourceTitle: "Password" },
    ]);
  });
});

describe("draftToRunRequest", () => {
  it("builds the run payload with trimmed fields, filtered steps, and provenance", () => {
    const draft = createEmptyDraft();
    draft.setup.baseUrl = "  https://app.example.com/login  ";
    draft.setup.executionNotes = "  ";
    draft.setup.screenshotPolicy = "failures-only";
    draft.provenance = { planId: 7, suiteId: 8 };
    draft.cases = mergeImportedCases([], [{
      azureTestCaseId: 1, azureTestPointId: 10, azurePlanId: 7, azureSuiteId: 8,
      title: "  Imported  ", steps: [{ action: " Open " , expectedResult: " Loads " }, { action: "   " }], source: "plan-suite",
    }]);
    const request = draftToRunRequest(draft, scope);
    expect(request).toEqual({
      scope,
      baseUrl: "https://app.example.com/login",
      screenshotPolicy: "failures-only",
      testData: [],
      planId: 7,
      suiteId: 8,
      cases: [{
        azureTestCaseId: 1, azureTestPointId: 10, azurePlanId: 7, azureSuiteId: 8,
        title: "Imported",
        steps: [{ action: "Open", expectedResult: "Loads" }],
      }],
    });
    expect(request).not.toHaveProperty("executionNotes");
  });

  it("sends null Azure ids for manual cases and includes trimmed notes", () => {
    const draft = createEmptyDraft();
    draft.setup.baseUrl = "https://app.example.com";
    draft.setup.executionNotes = " Use the staging tenant. ";
    draft.cases = mergeImportedCases([], [{ title: "Manual", steps: [{ action: "Do" }], source: "manual" }]);
    const request = draftToRunRequest(draft, scope);
    expect(request.executionNotes).toBe("Use the staging tenant.");
    expect(request.cases[0]).toMatchObject({ azureTestCaseId: null, azureTestPointId: null, azurePlanId: null, azureSuiteId: null });
    expect(request).not.toHaveProperty("planId");
  });
});

describe("setupToProfileRequest", () => {
  it("maps the setup to a profile write with nulls for blank optionals", () => {
    const draft = createEmptyDraft();
    draft.setup.screenshotPolicy = "every-step";
    draft.setup.testData = [{ localId: "1", title: "Password", isSecret: true, value: "S3cret" }];
    expect(setupToProfileRequest({ scope, name: "  Staging  ", setup: draft.setup })).toEqual({
      scope,
      name: "Staging",
      baseUrl: null,
      executionNotes: null,
      screenshotPolicy: "every-step",
      testData: [{ title: "Password", isSecret: true, value: "S3cret" }],
    });
  });
});
