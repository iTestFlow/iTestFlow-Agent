import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  getUserLLMProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  fetchWorkItemById: vi.fn(),
  resolveWorkflowContext: vi.fn(),
  getRetrievalTopK: vi.fn(),
  getSavedProjectKnowledgeBase: vi.fn(),
  generateTestCases: vi.fn(),
  buildWorkflowContextCitations: vi.fn(),
  writeGenerationFailureAudit: vi.fn(),
  startWorkflowRun: vi.fn(),
  updateWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
    getUserLLMProvider: mocks.getUserLLMProvider,
  };
});
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
vi.mock("@/modules/rag/workflow-context-citations", () => ({
  buildWorkflowContextCitations: mocks.buildWorkflowContextCitations,
}));
vi.mock("@/modules/test-case-design/application/test-case-generation.service", () => ({
  generateTestCases: mocks.generateTestCases,
}));
vi.mock("@/modules/audit/generation-failure-audit", () => ({
  writeGenerationFailureAudit: mocks.writeGenerationFailureAudit,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  updateWorkflowRun: mocks.updateWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import {
  fakeAzureAdapter,
  fakeLlmProvider,
  jsonRequest,
  projectScope,
  requirement,
} from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();

function generateRequest(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/test-cases/generate", {
    scope: { ...trustedScope, workspaceId: "ws-1" },
    targetWorkItemId: "101",
    selectedContextIds: ["202"],
    ...overrides,
  });
}

describe("POST /api/test-cases/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const provider = fakeLlmProvider();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user-1",
      workspace: { id: "ws-1" },
    });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      fetchWorkItemById: mocks.fetchWorkItemById,
    }));
    mocks.getUserLLMProvider.mockResolvedValue(provider);
    mocks.fetchWorkItemById.mockResolvedValue(requirement());
    mocks.getRetrievalTopK.mockResolvedValue(8);
    mocks.resolveWorkflowContext.mockResolvedValue({
      relatedWorkItems: [],
      selectedContext: [],
      contextUsed: [],
      retrievalTopK: 8,
    });
    mocks.getSavedProjectKnowledgeBase.mockResolvedValue(null);
    mocks.buildWorkflowContextCitations.mockReturnValue([]);
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.generateTestCases.mockResolvedValue({
      provider: "openai",
      model: "test-model",
      rawOutput: "{}",
      validatedOutput: {
        testCases: [{ id: "TC-1", type: "functional", category: "positive" }],
        summary: { totalCases: 1, coverageEstimate: 91 },
        contextUsed: ["requirement-101"],
      },
      relevantProjectKnowledgeBase: null,
      warnings: ["One optional field was normalized."],
    });
  });

  it("orchestrates trusted context and records a successful analytics run", async () => {
    mocks.buildWorkflowContextCitations.mockReturnValue([{
      sourceType: "project_context",
      sourceId: "WI:202",
      title: "Payment API",
      workItemId: "202",
      workItemType: "User Story",
    }]);

    const response = await POST(generateRequest({ extraInstructions: "Focus on retries." }));

    expect(response.status).toBe(200);
    expect(mocks.fetchWorkItemById).toHaveBeenCalledExactlyOnceWith({
      projectId: trustedScope.azureProjectId,
      workItemId: "101",
    });
    expect(mocks.resolveWorkflowContext).toHaveBeenCalledWith(expect.objectContaining({
      scope: trustedScope,
      actor: "user-1",
      selectedContextIds: ["202"],
      retrievalTopK: 8,
      workflowType: "test_case_generation",
    }));
    expect(mocks.generateTestCases).toHaveBeenCalledWith(expect.objectContaining({
      scope: trustedScope,
      actor: "user-1",
      extraInstructions: "Focus on retries.",
    }));
    expect(mocks.updateWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      patch: expect.objectContaining({
        status: "generated",
        itemsGenerated: 1,
        usedKnowledgeContext: true,
        metadata: {
          testDesign: { categories: { Positive: 1 } },
          coverage: { score: 91 },
          contextUsed: ["requirement-101"],
        },
      }),
    });
    expect(await response.json()).toMatchObject({
      analyticsRunId: "run-1",
      testCases: [{ id: "TC-1" }],
      tokenUsage: { input: 10, output: 20, total: 30 },
      warnings: ["One optional field was normalized."],
    });
  });

  it("rejects malformed JSON before resolving credentials", async () => {
    const request = new Request("http://localhost/api/test-cases/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });

    const response = await POST(request);

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("preserves project authorization failures and does not start generation", async () => {
    mocks.resolveProjectScope.mockRejectedValue(new WorkflowAuthError("Project not found.", 404));

    const response = await POST(generateRequest());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found." });
    expect(mocks.startWorkflowRun).not.toHaveBeenCalled();
    expect(mocks.generateTestCases).not.toHaveBeenCalled();
  });

  it("audits a provider failure, fails the run, and returns the mapped status", async () => {
    mocks.generateTestCases.mockRejectedValue(new AppError({
      code: AppErrorCode.Network,
      message: "Azure OpenAI request timed out.",
      userMessage: "The LLM request could not be completed.",
    }));

    const response = await POST(generateRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: "The LLM request could not be completed.",
      code: AppErrorCode.Network,
    });
    expect(mocks.writeGenerationFailureAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        scope: trustedScope,
        actor: "user-1",
        action: "test_case_generation.run",
      }),
    );
    expect(mocks.failWorkflowRun).toHaveBeenCalledExactlyOnceWith({
      scope: trustedScope,
      runId: "run-1",
      error: "Azure OpenAI request timed out.",
    });
    expect(mocks.updateWorkflowRun).not.toHaveBeenCalled();
  });
});
