import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  publishApprovedTestCases: vi.fn(),
  completeWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));

// Keep the real authErrorResponse so auth failures raised by the mocked
// context/adapter resolvers still exercise the route's 401/403 mapping.
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
  };
});
// publishApprovedTestCases' per-case create/link/suite orchestration is its own
// service; here the route's contract is what it forwards in and derives out.
vi.mock("@/modules/integrations/azure-devops/azure-devops-test-plan.service", () => ({
  publishApprovedTestCases: mocks.publishApprovedTestCases,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  completeWorkflowRun: mocks.completeWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function testCaseInput(overrides: Record<string, unknown> = {}) {
  return {
    localId: "tc-1",
    targetUserStoryId: "42",
    title: "Successful checkout",
    steps: [{ action: "Open checkout", expectedResult: "Checkout is displayed" }],
    priority: 2,
    ...overrides,
  };
}

function publishRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/publish/test-cases", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    targetWorkItemId: "42",
    testPlanId: "10",
    testSuiteId: "20",
    suiteMode: "existing",
    testCases: [testCaseInput()],
    ...overrides,
  });
}

function caseResult(overrides: Record<string, unknown> = {}) {
  return {
    localId: "tc-1",
    azureTestCaseId: "900",
    success: true,
    create: { success: true },
    link: { success: true },
    suite: { success: true },
    ...overrides,
  };
}

describe("POST /api/publish/test-cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter());
    mocks.publishApprovedTestCases.mockResolvedValue({ results: [caseResult()] });
  });

  it("normalizes plan/suite URLs to numeric IDs before publishing", async () => {
    const response = await POST(publishRequest({
      testPlanId: "https://dev.azure.com/demo/p/_testPlans/define?planId=45&suiteId=7",
      testSuiteId: "&suiteId=7",
    }));

    expect(response.status).toBe(200);
    expect(mocks.publishApprovedTestCases).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      trustedScope,
      expect.objectContaining({ testPlanId: "45", testSuiteId: "7" }),
    );
    // The response echoes the normalized IDs, not the raw client input.
    expect(await response.json()).toMatchObject({ testPlanId: "45", testSuiteId: "7" });
  });

  it("accepts bare numeric and path-form plan IDs", async () => {
    const response = await POST(publishRequest({
      suiteMode: "none",
      testPlanId: "/plans/123/",
      testSuiteId: undefined,
    }));

    expect(response.status).toBe(200);
    expect(mocks.publishApprovedTestCases).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      trustedScope,
      expect.objectContaining({ testPlanId: "123" }),
    );
  });

  it("rejects a garbage plan reference with the field-level message before any auth work", async () => {
    const response = await POST(publishRequest({ testPlanId: "not-a-plan" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Enter a valid Azure Test Plan ID or URL." });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.publishApprovedTestCases).not.toHaveBeenCalled();
  });

  it("maps label, string-digit, and empty priorities onto the Azure 1-4 scale", async () => {
    const response = await POST(publishRequest({
      testCases: [
        testCaseInput({ localId: "tc-1", priority: "critical" }),
        testCaseInput({ localId: "tc-2", priority: "high" }),
        testCaseInput({ localId: "tc-3", priority: "medium" }),
        testCaseInput({ localId: "tc-4", priority: "low" }),
        testCaseInput({ localId: "tc-5", priority: "" }),
        testCaseInput({ localId: "tc-6", priority: "3" }),
      ],
    }));

    expect(response.status).toBe(200);
    const input = mocks.publishApprovedTestCases.mock.calls[0][2];
    expect(input.testCases.map((testCase: { priority: number }) => testCase.priority)).toEqual([1, 2, 3, 4, 2, 3]);
  });

  it("rejects an unrecognized priority with a 400", async () => {
    const response = await POST(publishRequest({
      testCases: [testCaseInput({ priority: "urgent" })],
    }));

    expect(response.status).toBe(400);
    expect(mocks.publishApprovedTestCases).not.toHaveBeenCalled();
  });

  it("requires a test suite ID in existing mode", async () => {
    const response = await POST(publishRequest({ testSuiteId: undefined }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Select or enter an existing Test Suite ID before publishing.",
    });
  });

  it("requires a test plan ID for every suite mode except none", async () => {
    const response = await POST(publishRequest({ testPlanId: undefined }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Select or enter an Azure Test Plan ID before publishing to a suite.",
    });

    // suiteMode none skips the plan requirement entirely.
    const none = await POST(publishRequest({ suiteMode: "none", testPlanId: undefined, testSuiteId: undefined }));
    expect(none.status).toBe(200);
  });

  it("requires a parent suite ID and a numeric work item ID in requirement mode", async () => {
    const missingParent = await POST(publishRequest({
      suiteMode: "requirement",
      testSuiteId: undefined,
      parentSuiteId: undefined,
    }));
    expect(missingParent.status).toBe(400);
    expect(await missingParent.json()).toEqual({
      error: "Select or enter the parent suite ID for the requirement-based suite.",
    });

    const nonNumericStory = await POST(publishRequest({
      suiteMode: "requirement",
      testSuiteId: undefined,
      parentSuiteId: "30",
      targetWorkItemId: "US-42",
    }));
    expect(nonNumericStory.status).toBe(400);
    expect(await nonNumericStory.json()).toEqual({
      error: "Requirement-based suites require a numeric Azure User Story work item ID.",
    });
  });

  it("completes the analytics run with itemsPublished and per-action counts when any case succeeds", async () => {
    // Two cases: one fully published (create+link+suite = 3 actions), one where
    // only creation succeeded (1 action); requirement suite adds 1 more.
    mocks.publishApprovedTestCases.mockResolvedValue({
      results: [
        caseResult(),
        caseResult({
          localId: "tc-2",
          success: false,
          link: { success: false, error: "link failed" },
          suite: { success: false, error: "Skipped because user story link failed." },
        }),
      ],
      requirementSuite: { success: true, suiteId: "70" },
    });

    const response = await POST(publishRequest({
      suiteMode: "requirement",
      testSuiteId: undefined,
      parentSuiteId: "30",
      testCases: [testCaseInput(), testCaseInput({ localId: "tc-2" })],
      analyticsRunId: "run-1",
      itemsGenerated: 5,
      itemsEdited: 1,
    }));

    expect(response.status).toBe(200);
    expect(mocks.completeWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      status: "published",
      valueRealized: true,
      patch: {
        itemsSelected: 2,
        itemsEdited: 1,
        itemsPublished: 1,
        itemsRejected: 3,
        manualActionsAvoided: 5,
      },
    });
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
  });

  it("fails the analytics run when no case published successfully but still returns the results", async () => {
    mocks.publishApprovedTestCases.mockResolvedValue({
      results: [caseResult({
        success: false,
        azureTestCaseId: undefined,
        create: { success: false, error: "create failed" },
        link: { success: false, error: "Skipped because test case creation failed." },
        suite: { success: false, error: "Skipped because test case creation failed." },
        error: "create failed",
      })],
    });

    const response = await POST(publishRequest({ analyticsRunId: "run-1" }));

    expect(response.status).toBe(200);
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "No test cases were published successfully.",
    });
    expect(mocks.completeWorkflowRun).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      suiteMode: "existing",
      results: [expect.objectContaining({ success: false, error: "create failed" })],
    });
  });

  it("records no analytics when the request carries no run ID", async () => {
    const response = await POST(publishRequest());

    expect(response.status).toBe(200);
    expect(mocks.completeWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
  });

  it("fails the analytics run and returns 503 when publishing throws after scope resolution", async () => {
    mocks.publishApprovedTestCases.mockRejectedValue(new Error("Azure unavailable"));

    const response = await POST(publishRequest({ analyticsRunId: "run-1" }));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("The service is temporarily unavailable. Try again in a moment.");
    expect(body.technicalDetails).toContain("Azure unavailable");
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "Azure unavailable",
    });
  });
});
