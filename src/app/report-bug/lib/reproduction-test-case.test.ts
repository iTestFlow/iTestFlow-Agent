import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  writeAuditLog: vi.fn(),
  createTestCase: vi.fn(),
  linkTestCaseToUserStory: vi.fn(),
  linkTestCaseToWorkItem: vi.fn(),
}));

// The route mocks only apply to the round-trip suite at the bottom; the
// builders themselves are pure and import nothing that is mocked here.
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

import { POST as publishReproductionTestCase } from "@/app/api/bugs/reproduction-test-case/publish/route";
import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import {
  buildReproductionTestCaseTitle,
  buildSuggestedTestCaseFromBugReport,
  testCaseTitleFromExpectedResult,
  type ReproductionBugReport,
} from "./reproduction-test-case";

function bugReport(overrides: Partial<ReproductionBugReport> = {}): ReproductionBugReport {
  return {
    title: "Checkout crashes when submitting an empty cart",
    precondition: "User is signed in with an empty cart",
    stepsToReproduce: "1. Open the cart page\n2. Click Checkout\n3. Confirm the order",
    expectedResult: "The system should block checkout with a validation message",
    actualResult: "A 500 error page is shown",
    systemInfo: "Chrome 126 on Windows 11",
    priority: 2,
    environment: "staging",
    category: "Functional",
    ...overrides,
  };
}

describe("buildSuggestedTestCaseFromBugReport", () => {
  it("maps numbered repro steps to sequential steps behind a preconditions step", () => {
    const testCase = buildSuggestedTestCaseFromBugReport(bugReport(), "Submitting an empty cart crashes checkout.");

    // Only the final reproduction step carries the report's expected result.
    expect(testCase.steps).toEqual([
      { stepNumber: 1, action: "Preconditions:\nUser is signed in with an empty cart", expectedResult: "Preconditions are met" },
      { stepNumber: 2, action: "Open the cart page", expectedResult: "Step completes successfully." },
      { stepNumber: 3, action: "Click Checkout", expectedResult: "Step completes successfully." },
      { stepNumber: 4, action: "Confirm the order", expectedResult: "The system should block checkout with a validation message" },
    ]);
    expect(testCase.preconditions).toBe("User is signed in with an empty cart");
    expect(testCase.description).toBe(
      "Bug description:\nSubmitting an empty cart crashes checkout.\n\nActual result to prevent:\nA 500 error page is shown",
    );
    expect(testCase).toMatchObject({ priority: 2, type: "regression", category: "Functional", testData: "Chrome 126 on Windows 11" });
    expect(testCase.id).toMatch(/^bug-repro-tc-[a-z0-9]+$/);
  });

  it("splits unnumbered repro steps per line and falls back to environment for test data", () => {
    const testCase = buildSuggestedTestCaseFromBugReport(
      bugReport({ stepsToReproduce: "Open the cart page\nClick Checkout", systemInfo: "" }),
      "",
    );

    expect(testCase.steps.map((step) => step.action)).toEqual([
      "Preconditions:\nUser is signed in with an empty cart",
      "Open the cart page",
      "Click Checkout",
    ]);
    expect(testCase.testData).toBe("staging");
  });

  it("falls back to the bug description as the single reproduction step when steps are empty", () => {
    const testCase = buildSuggestedTestCaseFromBugReport(
      bugReport({ stepsToReproduce: "" }),
      "Submitting an empty cart crashes checkout.",
    );

    expect(testCase.steps).toEqual([
      { stepNumber: 1, action: "Preconditions:\nUser is signed in with an empty cart", expectedResult: "Preconditions are met" },
      {
        stepNumber: 2,
        action: "Submitting an empty cart crashes checkout.",
        expectedResult: "The system should block checkout with a validation message",
      },
    ]);
  });

  it("degrades to the report title and placeholder defaults when every optional field is empty", () => {
    const testCase = buildSuggestedTestCaseFromBugReport(
      bugReport({
        stepsToReproduce: "",
        precondition: "",
        expectedResult: "",
        actualResult: "",
        systemInfo: "",
        environment: undefined,
        category: undefined,
      }),
      "",
    );

    expect(testCase.steps).toEqual([
      { stepNumber: 1, action: "Preconditions:\nNo specific preconditions were generated.", expectedResult: "Preconditions are met" },
      { stepNumber: 2, action: "Checkout crashes when submitting an empty cart", expectedResult: "" },
    ]);
    expect(testCase.description).toBe("");
    expect(testCase.category).toBe("Functional");
    expect(testCase.testData).toBe("");
    expect(testCase.title).toBe("Verify reported defect reproduction scenario");
  });
});

describe("buildReproductionTestCaseTitle", () => {
  it("prefers a title derived from the expected result", () => {
    expect(buildReproductionTestCaseTitle(bugReport())).toBe(
      "Verify the system block checkout with a validation message",
    );
  });

  it("skips an expected-result title matching the bug title and derives one from the first repro step", () => {
    const report = bugReport({ title: "Verify checkout succeeds", expectedResult: "checkout succeeds" });
    expect(buildReproductionTestCaseTitle(report)).toBe("Verify reproduction flow: Open the cart page");
  });

  it("falls back to a lowercased category scenario when neither expected result nor steps exist", () => {
    expect(buildReproductionTestCaseTitle(bugReport({ expectedResult: "", stepsToReproduce: "", category: "Usability" }))).toBe(
      "Verify usability reproduction scenario",
    );
    expect(buildReproductionTestCaseTitle(bugReport({ expectedResult: "", stepsToReproduce: "", category: undefined }))).toBe(
      "Verify reported defect reproduction scenario",
    );
  });
});

describe("testCaseTitleFromExpectedResult", () => {
  it("rewrites 'the system should' expectations", () => {
    expect(testCaseTitleFromExpectedResult("The system should reject duplicate emails.")).toBe(
      "Verify the system reject duplicate emails",
    );
  });

  it("rewrites '<subject> should <behavior>' expectations", () => {
    expect(testCaseTitleFromExpectedResult("Totals should refresh after discounts are applied")).toBe(
      "Verify Totals refresh after discounts are applied",
    );
  });

  it("keeps only the first clause and strips terminal punctuation", () => {
    expect(testCaseTitleFromExpectedResult("Order total updates, tax recalculates. Receipt is emailed.")).toBe(
      "Verify Order total updates",
    );
  });

  it("returns an empty title for blank input", () => {
    expect(testCaseTitleFromExpectedResult("")).toBe("");
    expect(testCaseTitleFromExpectedResult("   \n  ")).toBe("");
  });

  // Truncation boundary is 140 characters: "Verify " (7 chars) + expectation.
  it("keeps a 140-character title untruncated", () => {
    const title = testCaseTitleFromExpectedResult("x".repeat(133));
    expect(title).toBe(`Verify ${"x".repeat(133)}`);
    expect(title).toHaveLength(140);
  });

  it("truncates a 141-character title to a 137-character slice plus ellipsis", () => {
    const title = testCaseTitleFromExpectedResult("x".repeat(134));
    expect(title).toBe(`Verify ${"x".repeat(130)}...`);
    expect(title).toHaveLength(140);
  });
});

// Pins the contract between the builder output and the reproduction publish
// route: the suggested test case must pass the route's zod schema and arrive
// intact in the Azure createTestCase call.
describe("suggested test case round-trip through the reproduction publish route", () => {
  const trustedScope = projectScope();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      createTestCase: mocks.createTestCase,
      linkTestCaseToUserStory: mocks.linkTestCaseToUserStory,
      linkTestCaseToWorkItem: mocks.linkTestCaseToWorkItem,
    }));
    mocks.createTestCase.mockResolvedValue({ success: true, azureTestCaseId: "900" });
    mocks.linkTestCaseToUserStory.mockResolvedValue({ success: true });
    mocks.linkTestCaseToWorkItem.mockResolvedValue({ success: true });
  });

  it("is accepted by the publish schema and mapped verbatim into the Azure create call", async () => {
    const suggested = buildSuggestedTestCaseFromBugReport(bugReport(), "Submitting an empty cart crashes checkout.");

    const response = await publishReproductionTestCase(jsonRequest("/api/bugs/reproduction-test-case/publish", {
      scope: { ...trustedScope, workspaceId: "ws-1" },
      parentStoryId: "42",
      bugId: "77",
      suggestedTestCase: suggested,
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ mode: "suggested", azureTestCaseId: "900", success: true });
    expect(mocks.createTestCase).toHaveBeenCalledExactlyOnceWith({
      projectId: trustedScope.azureProjectId,
      testCase: expect.objectContaining({
        localId: suggested.id,
        targetUserStoryId: "42",
        title: suggested.title,
        description: suggested.description,
        priority: suggested.priority,
        testType: "regression",
        preconditions: suggested.preconditions,
        testData: suggested.testData,
        steps: suggested.steps.map(({ action, expectedResult }) => ({ action, expectedResult })),
      }),
    });
  });
});
