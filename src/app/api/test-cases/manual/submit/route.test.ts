import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireExternalLlmEnabled: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  fetchWorkItemById: vi.fn(),
  verifyManualDraftToken: vi.fn(),
  verifyManualDraftContract: vi.fn(),
  resolveProjectScope: vi.fn(),
  completeManualTestCaseGeneration: vi.fn(),
  startWorkflowRun: vi.fn(),
  updateWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireExternalLlmEnabled: mocks.requireExternalLlmEnabled,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/test-case-design/application/test-case-generation.service", () => ({
  completeManualTestCaseGeneration: mocks.completeManualTestCaseGeneration,
}));
vi.mock("@/modules/test-case-design/manual-draft-token", () => ({
  verifyManualDraftToken: mocks.verifyManualDraftToken,
  verifyManualDraftContract: mocks.verifyManualDraftContract,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  updateWorkflowRun: mocks.updateWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { AcceptanceCriteriaError } from "@/modules/test-case-design/acceptance-criteria-contract";
import { fakeAzureAdapter, jsonRequest, projectScope, requirement } from "@/test/factories";
import { buildAcceptanceCriteriaContract } from "@/modules/test-case-design/acceptance-criteria-contract";
import { POST } from "./route";

const trustedScope = projectScope();

function submitRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/test-cases/manual/submit", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    targetWorkItemId: "101",
    rawOutput: "external response",
    draftToken: "sealed-draft",
    contextCitations: [],
    ...overrides,
  });
}

describe("POST /api/test-cases/manual/submit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user-1",
      workspace: { id: "ws-1", providerId: "azure-devops" },
    });
    mocks.requireExternalLlmEnabled.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.fetchWorkItemById.mockResolvedValue(requirement());
    mocks.verifyManualDraftToken.mockReturnValue({ contractVersion: "1", sourceHash: "prepared-hash" });
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({ fetchWorkItemById: mocks.fetchWorkItemById }));
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.completeManualTestCaseGeneration.mockReturnValue({
      provider: "external",
      model: "manual-external",
      rawOutput: "external response",
      validatedOutput: {
        testCases: [{ id: "TC-1", type: "functional", category: "negative" }],
        summary: { totalCases: 1, coverageEstimate: 82 },
        contextUsed: ["requirement-101"],
      },
      acceptanceCriteriaContract: buildAcceptanceCriteriaContract(requirement()),
      acceptanceCriteriaCoverage: { requiredCount: 1, coveredCount: 1, missingCriteria: [], unknownReferences: [], casePositionsByCriterion: { "AC-001": [1] } },
    });
  });

  it("returns generated cases and completes analytics with observable coverage metadata", async () => {
    const response = await POST(submitRequest({
      selectedContextIds: ["202"],
      contextCitations: [{
        sourceType: "project_context",
        sourceId: "WI:202",
        title: "Payment API",
        workItemId: "202",
        workItemType: "User Story",
      }],
      retrievalTopK: 5,
    }));

    expect(response.status).toBe(200);
    expect(mocks.completeManualTestCaseGeneration).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      actor: "user-1",
      rawOutput: "external response",
      targetWorkItemId: "101",
      acceptanceCriteriaContract: buildAcceptanceCriteriaContract(requirement()),
    });
    expect(mocks.verifyManualDraftToken).toHaveBeenCalledExactlyOnceWith("sealed-draft", {
      userId: "user-1", workspaceId: "ws-1", projectId: trustedScope.projectId,
      integrationProvider: "azure-devops", storyId: "101",
    });
    expect(mocks.verifyManualDraftContract).toHaveBeenCalledExactlyOnceWith(
      { contractVersion: "1", sourceHash: "prepared-hash" },
      buildAcceptanceCriteriaContract(requirement()),
    );
    expect(mocks.updateWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      patch: expect.objectContaining({
        status: "generated",
        itemsGenerated: 1,
        usedKnowledgeContext: true,
        metadata: {
          testDesign: { categories: { Negative: 1 } },
          coverage: { score: 82, acceptanceCriteria: { requiredCount: 1, coveredCount: 1, correctionAttempts: 0 } },
          contextUsed: ["requirement-101"],
        },
      }),
    });
    expect(mocks.failWorkflowRun).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      analyticsRunId: "run-1",
      targetWorkItemId: "101",
      retrievalTopK: 5,
      testCases: [{ id: "TC-1" }],
    });
  });

  it("rejects malformed JSON before authenticating or starting analytics", async () => {
    const request = new Request("http://localhost/api/test-cases/manual/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects an empty external response with the stable paste-response message", async () => {
    const response = await POST(submitRequest({ rawOutput: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Paste the external LLM response before continuing.",
    });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("preserves authorization failures without starting a workflow run", async () => {
    mocks.requireWorkflowContext.mockRejectedValue(
      new WorkflowAuthError("Project access denied.", 403),
    );

    const response = await POST(submitRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Project access denied." });
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("short-circuits disabled External LLM workflows before scope resolution or analytics", async () => {
    mocks.requireExternalLlmEnabled.mockRejectedValue(
      new WorkflowAuthError("External LLM is disabled by a workspace owner or admin.", 403),
    );

    const response = await POST(submitRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "External LLM is disabled by a workspace owner or admin." });
    expect(mocks.resolveProjectScope).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.completeManualTestCaseGeneration).not.toHaveBeenCalled();
  });

  it("fails the started run and maps invalid pasted output to a 422", async () => {
    mocks.completeManualTestCaseGeneration.mockImplementation(() => {
      throw new AppError({
        code: AppErrorCode.SchemaValidation,
        message: "testCases is required.",
        userMessage: "The pasted output does not match the expected format.",
      });
    });

    const response = await POST(submitRequest());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: "The pasted output does not match the expected format.",
      code: AppErrorCode.SchemaValidation,
    });
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "testCases is required.",
    });
    expect(mocks.updateWorkflowRun).not.toHaveBeenCalled();
  });

  it("requires older manual drafts to be prepared again", async () => {
    const response = await POST(submitRequest({ draftToken: undefined }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Prepare a fresh prompt") });
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects a stale draft before starting analytics or accepting pasted output", async () => {
    mocks.verifyManualDraftToken.mockImplementationOnce(() => {
      throw new AcceptanceCriteriaError(AppErrorCode.AcceptanceCriteriaDraftStale, "Story changed. Prepare a fresh prompt.");
    });
    const response = await POST(submitRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: AppErrorCode.AcceptanceCriteriaDraftStale });
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.completeManualTestCaseGeneration).not.toHaveBeenCalled();
  });

  it("returns stale draft when the refetched story has no parseable acceptance criteria", async () => {
    mocks.fetchWorkItemById.mockResolvedValueOnce({ ...requirement(), acceptanceCriteria: "<table><tr><td>Ambiguous</td></tr></table>" });
    const response = await POST(submitRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: AppErrorCode.AcceptanceCriteriaDraftStale });
    expect(mocks.verifyManualDraftToken).toHaveBeenCalledOnce();
    expect(mocks.verifyManualDraftContract).not.toHaveBeenCalled();
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
  });

  it("does not accept pasted output when the scoped story cannot be refetched", async () => {
    mocks.fetchWorkItemById.mockRejectedValueOnce(new Error("story unavailable"));
    const response = await POST(submitRequest());
    expect(response.status).not.toBe(200);
    expect(mocks.completeManualTestCaseGeneration).not.toHaveBeenCalled();
  });
});
