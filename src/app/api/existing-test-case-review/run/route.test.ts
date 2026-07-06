import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  getUserLLMProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchWorkItemById: vi.fn(),
  fetchLinkedTestCases: vi.fn(),
  reviewExistingLinkedTestCases: vi.fn(),
  resolveWorkflowContext: vi.fn(),
  getRetrievalTopK: vi.fn(),
  getSavedProjectKnowledgeBase: vi.fn(),
  writeGenerationFailureAudit: vi.fn(),
  startWorkflowRun: vi.fn(),
  updateWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));

// Keep the real authErrorResponse so generation failures fall through it to the
// audit + failWorkflowRun path instead of being swallowed as auth errors.
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
    getUserLLMProvider: mocks.getUserLLMProvider,
  };
});
// The review service's prompt/audit behavior is covered by
// existing-test-case-review.test.ts; here it is the boundary the route
// orchestrates around. Metric derivation itself is pinned by review-metrics.test.ts.
vi.mock("@/modules/existing-test-case-review/application/existing-test-case-review.service", () => ({
  reviewExistingLinkedTestCases: mocks.reviewExistingLinkedTestCases,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/auto-context-resolver.service", () => ({
  resolveWorkflowContext: mocks.resolveWorkflowContext,
}));
vi.mock("@/modules/rag/retrieval-config", () => ({
  getRetrievalTopK: mocks.getRetrievalTopK,
}));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  getSavedProjectKnowledgeBase: mocks.getSavedProjectKnowledgeBase,
}));
vi.mock("@/modules/audit/generation-failure-audit", () => ({
  writeGenerationFailureAudit: mocks.writeGenerationFailureAudit,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  updateWorkflowRun: mocks.updateWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { fakeAzureAdapter, fakeLlmProvider, jsonRequest, projectScope, requirement, testCase } from "@/test/factories";
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

function runRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/existing-test-case-review/run", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    targetWorkItemId: "101",
    ...overrides,
  });
}

describe("POST /api/existing-test-case-review/run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserLLMProvider.mockResolvedValue(fakeLlmProvider());
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      fetchWorkItemById: mocks.fetchWorkItemById,
      fetchLinkedTestCases: mocks.fetchLinkedTestCases,
    }));
    mocks.fetchWorkItemById.mockResolvedValue(requirement());
    mocks.fetchLinkedTestCases.mockResolvedValue([testCase()]);
    mocks.resolveWorkflowContext.mockResolvedValue({
      selectedContext: [],
      relatedWorkItems: [],
      contextUsed: [],
      retrievalTopK: 5,
    });
    mocks.getRetrievalTopK.mockResolvedValue(5);
    mocks.getSavedProjectKnowledgeBase.mockResolvedValue(null);
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.reviewExistingLinkedTestCases.mockResolvedValue({
      provider: "openai",
      model: "test-model",
      rawOutput: "{}",
      validatedOutput: reviewOutput(),
      warnings: [],
      relevantProjectKnowledgeBase: null,
    });
  });

  it("completes the run with the derived severity, weak/duplicate, and gap metrics in the patch", async () => {
    const response = await POST(runRequest());

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
    expect(await response.json()).toMatchObject({ analyticsRunId: "run-1", coverageScore: 62 });
  });

  it("maps a generation failure to exactly one audit entry and one failed run", async () => {
    mocks.reviewExistingLinkedTestCases.mockRejectedValue(new AppError({
      code: AppErrorCode.ProviderUnavailable,
      message: "OpenAI returned 503.",
      userMessage: "The LLM provider is currently unavailable.",
    }));

    const response = await POST(runRequest());

    // ProviderUnavailable -> 503 via statusForServerError.
    expect(response.status).toBe(503);
    expect(mocks.writeGenerationFailureAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ scope: trustedScope, actor: "user-1", action: "existing_test_case_review.run" }),
    );
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "OpenAI returned 503.",
    });
    expect(mocks.updateWorkflowRun).not.toHaveBeenCalled();
  });
});
