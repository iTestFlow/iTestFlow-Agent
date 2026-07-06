import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchLinkedTestCases: vi.fn(),
  completeManualExistingTestCaseReview: vi.fn(),
  startWorkflowRun: vi.fn(),
  updateWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));

// Keep the real authErrorResponse so validation failures fall through it to the
// failWorkflowRun + statusForManualValidationError path.
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
  };
});
// Raw-output parsing/audit behavior is covered by existing-test-case-review.test.ts;
// here it is the boundary the route orchestrates around. Metric derivation itself
// is pinned by review-metrics.test.ts.
vi.mock("@/modules/existing-test-case-review/application/existing-test-case-review.service", () => ({
  completeManualExistingTestCaseReview: mocks.completeManualExistingTestCaseReview,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  updateWorkflowRun: mocks.updateWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

// 1 High / 1 Medium / 1 Low finding, 2 weak-or-duplicate categories, and 2 of
// 3 matrix rows not exactly "Covered" -> the metrics the patch must carry.
function reviewOutput() {
  return {
    summary: "Checkout coverage has gaps.",
    coverageScore: 62,
    traceabilityMatrix: [
      { id: "TM-1", coverageStatus: "Covered" },
      { id: "TM-2", coverageStatus: "Not covered" },
      { id: "TM-3", coverageStatus: "Partially covered" },
    ],
    insights: [],
    findings: [
      { id: "F-1", severity: "High", category: "Missing coverage" },
      { id: "F-2", severity: "Medium", category: "Duplicate" },
      { id: "F-3", severity: "Low", category: "Weak steps" },
    ],
    suggestedAdditions: [{ id: "TC-GAP-1", title: "Declined payment", type: "functional", category: "negative" }],
    contextUsed: [],
  };
}

function submitRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/existing-test-case-review/manual/submit", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    targetWorkItemId: "101",
    rawOutput: "external llm response",
    contextCitations: [],
    ...overrides,
  });
}

describe("POST /api/existing-test-case-review/manual/submit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      fetchLinkedTestCases: mocks.fetchLinkedTestCases,
    }));
    mocks.fetchLinkedTestCases.mockResolvedValue([]);
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.completeManualExistingTestCaseReview.mockReturnValue({
      provider: "external",
      model: "manual-external",
      rawOutput: "external llm response",
      validatedOutput: reviewOutput(),
    });
  });

  it("completes the run with the derived severity, weak/duplicate, and gap metrics in the patch", async () => {
    const response = await POST(submitRequest());

    expect(response.status).toBe(200);
    expect(mocks.updateWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      patch: expect.objectContaining({
        status: "generated",
        itemsGenerated: 1,
        highRiskItemsFound: 1,
        mediumRiskItemsFound: 1,
        lowRiskItemsFound: 1,
        metadata: expect.objectContaining({
          coverage: { score: 62, missingAreas: 2, weakDuplicateCases: 2 },
        }),
      }),
    });
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ analyticsRunId: "run-1", provider: "external" });
  });

  it("maps invalid raw output to statusForManualValidationError and fails the pre-started run", async () => {
    mocks.completeManualExistingTestCaseReview.mockImplementation(() => {
      throw new AppError({
        code: AppErrorCode.SchemaValidation,
        message: "traceabilityMatrix is required.",
        userMessage: "The pasted output does not match the expected review format.",
      });
    });

    const response = await POST(submitRequest());

    // SchemaValidation -> 422 via statusForManualValidationError.
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "The pasted output does not match the expected review format.",
      code: AppErrorCode.SchemaValidation,
    });
    // The run started before validation must be failed, not leaked in "started".
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "traceabilityMatrix is required.",
    });
    expect(mocks.updateWorkflowRun).not.toHaveBeenCalled();
  });
});
