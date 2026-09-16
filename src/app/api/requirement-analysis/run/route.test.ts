import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  getUserLLMProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  resolveWorkflowContext: vi.fn(),
  resolveRetrievalTopK: vi.fn(),
  loadProjectKnowledgeContext: vi.fn(),
  rankProjectKnowledgeForWorkItem: vi.fn(),
  loadSelectedStoryAttachmentWorkflowContext: vi.fn(),
  runRequirementAnalysis: vi.fn(),
  writeGenerationFailureAudit: vi.fn(),
  startWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
  completeWorkflowRun: vi.fn(),
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
  resolveRetrievalTopK: mocks.resolveRetrievalTopK,
}));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  loadProjectKnowledgeContext: mocks.loadProjectKnowledgeContext,
}));
vi.mock("@/modules/rag/knowledge-relevance.service", () => ({
  rankProjectKnowledgeForWorkItem: mocks.rankProjectKnowledgeForWorkItem,
}));
vi.mock("@/modules/story-attachments/story-attachment-workflow-context", () => ({
  loadSelectedStoryAttachmentWorkflowContext: mocks.loadSelectedStoryAttachmentWorkflowContext,
}));
vi.mock("@/modules/requirement-analysis/application/requirement-analysis.service", () => ({
  runRequirementAnalysis: mocks.runRequirementAnalysis,
}));
vi.mock("@/modules/audit/generation-failure-audit", () => ({
  writeGenerationFailureAudit: mocks.writeGenerationFailureAudit,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/analytics/workflow-analytics.service")>();
  return {
    ...actual,
    startWorkflowRun: mocks.startWorkflowRun,
    failWorkflowRun: mocks.failWorkflowRun,
    completeWorkflowRun: mocks.completeWorkflowRun,
    updateWorkflowRun: vi.fn(),
  };
});

import { azureDevOpsIntegrationError } from "@/modules/integrations/azure-devops/azure-devops-error";
import { fakeAzureAdapter, fakeLlmProvider, jsonRequest, projectScope, requirement } from "@/test/factories";
import { POST } from "./route";

/**
 * The Run endpoint is where a requirement analysis is actually produced, and it had no
 * test at all — so the wiring that decides how much context reaches the model, and the
 * failure paths a user sees when Azure DevOps or the LLM is unavailable, were both
 * unguarded.
 */

const trustedScope = projectScope();
const context = {
  userId: "user-1",
  workspace: { id: "ws-1", providerId: "azure-devops", azureOrgUrl: "https://dev.azure.com/demo" },
};

function body() {
  return { scope: { ...trustedScope, workspaceId: "ws-1" }, targetWorkItemId: "123" };
}

describe("requirement-analysis run route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue(context);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      fetchWorkItemById: vi.fn(async () => requirement({ id: "123", title: "Target" })),
    }));
    mocks.getUserLLMProvider.mockResolvedValue({ ...fakeLlmProvider(), maxInputTokens: 128_000 });
    mocks.resolveRetrievalTopK.mockResolvedValue(6);
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.resolveWorkflowContext.mockResolvedValue({
      relatedWorkItems: [{ workItemId: "200" }],
      selectedContext: [{ workItemId: "201" }],
      contextUsed: [],
      retrievalTopK: 6,
    });
    mocks.loadProjectKnowledgeContext.mockResolvedValue({ knowledgeBase: {}, promptNotice: null });
    mocks.rankProjectKnowledgeForWorkItem.mockResolvedValue({ businessRules: ["rule-1"] });
    mocks.loadSelectedStoryAttachmentWorkflowContext.mockResolvedValue({
      promptAttachments: [],
      citationAttachments: [],
      images: [],
      imageTokenReserve: 0,
      effectivePromptInputTokens: 128_000,
      warnings: [],
    });
    mocks.runRequirementAnalysis.mockResolvedValue({
      validatedOutput: {
        findings: [],
        summary: { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 },
      },
      relevantProjectKnowledgeBase: null,
      includedStoryAttachmentTextIds: [],
      omittedStoryAttachmentTextIds: [],
    });
  });

  it("sends the model window, the retrieval floor and the ranked knowledge it selected", async () => {
    // These three are what make a large configured window actually buy more context.
    // They were dropped between the service boundary and the renderer once before,
    // which made every budget-driven behaviour silently inert on this path.
    const response = await POST(jsonRequest("/api/requirement-analysis/run", body()));

    expect(response.status).toBe(200);
    expect(mocks.runRequirementAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      maxInputTokens: 128_000,
      relatedWorkItemsFloor: 6,
      rankedKnowledgeKeys: { businessRules: ["rule-1"] },
    }));
  });

  it("anchors knowledge ranking on the work items context actually resolved", async () => {
    // Ranking anchored on the target alone would miss knowledge reachable only through
    // the items retrieval just decided were relevant.
    await POST(jsonRequest("/api/requirement-analysis/run", body()));

    expect(mocks.rankProjectKnowledgeForWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      contextWorkItemIds: ["200", "201"],
    }));
  });

  it("loads selected attachments under the stable story scope and sends text and visuals to the model", async () => {
    const target = requirement({ id: "PAY-123", raw: { id: "10042" } });
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      fetchWorkItemById: vi.fn(async () => target),
    }));
    const promptAttachments = [{
      id: "attachment-1",
      fileName: "checkout.png",
      mimeType: "image/png",
      text: "Checkout flow mockup omitted from the prompt.",
      visualCount: 1,
    }, {
      id: "attachment-no-evidence",
      fileName: "unreadable.txt",
      mimeType: "text/plain",
      text: "This text did not fit the prompt.",
      visualCount: 0,
    }];
    const images = [{ mediaType: "image/png" as const, data: "cG5n" }];
    mocks.loadSelectedStoryAttachmentWorkflowContext.mockResolvedValue({
      promptAttachments,
      citationAttachments: promptAttachments,
      images,
      imageTokenReserve: 8_000,
      effectivePromptInputTokens: 120_000,
      warnings: ["Attachment visual was reduced before sending it to the model."],
    });

    const response = await POST(jsonRequest("/api/requirement-analysis/run", {
      ...body(),
      targetWorkItemId: "PAY-123",
      attachmentIds: ["attachment-1"],
    }));

    expect(response.status).toBe(200);
    expect(mocks.loadSelectedStoryAttachmentWorkflowContext).toHaveBeenCalledWith({
      scope: {
        workspaceId: "ws-1",
        projectId: trustedScope.projectId,
        providerId: "azure-devops",
        canonicalStoryId: "10042",
        storyDisplayKey: "PAY-123",
      },
      attachmentIds: ["attachment-1"],
      includeVisuals: true,
      maxInputTokens: 128_000,
    });
    expect(mocks.runRequirementAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      storyAttachments: promptAttachments,
      attachmentImages: images,
      maxInputTokens: 120_000,
    }));
    expect(await response.json()).toMatchObject({
      warnings: ["Attachment visual was reduced before sending it to the model."],
      contextCitations: [{
        sourceType: "story_attachment",
        attachmentId: "attachment-1",
      }],
    });
  });

  it("still produces an analysis when knowledge ranking yields nothing", async () => {
    // Ranking is a refinement, never a dependency: returning null must fall back to
    // keyword ordering rather than fail the run.
    mocks.rankProjectKnowledgeForWorkItem.mockResolvedValue(null);

    const response = await POST(jsonRequest("/api/requirement-analysis/run", body()));

    expect(response.status).toBe(200);
    expect(mocks.runRequirementAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      rankedKnowledgeKeys: undefined,
    }));
  });

  it("maps an integration auth failure to 401 with the integration scope header", async () => {
    mocks.resolveWorkflowContext.mockRejectedValue(azureDevOpsIntegrationError(
      401,
      JSON.stringify({ message: "TF400813: not authorized" }),
      "_apis/wit/workitems/123?api-version=7.1",
    ));

    const response = await POST(jsonRequest("/api/requirement-analysis/run", body()));

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBe("integration");
  });

  it("records a generation failure audit and fails the run when generation throws", async () => {
    // Without the audit write a failed generation leaves no trace for the user or
    // support to find, and an unfinished analytics run stays open forever.
    mocks.runRequirementAnalysis.mockRejectedValue(new Error("model exploded"));

    const response = await POST(jsonRequest("/api/requirement-analysis/run", body()));

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(mocks.writeGenerationFailureAudit).toHaveBeenCalled();
    expect(mocks.failWorkflowRun).toHaveBeenCalled();
  });

  it("rejects a request with no target work item before doing any work", async () => {
    const response = await POST(jsonRequest("/api/requirement-analysis/run", {
      scope: { ...trustedScope, workspaceId: "ws-1" },
    }));

    expect(response.status).toBe(400);
    expect(mocks.resolveWorkflowContext).not.toHaveBeenCalled();
  });
});
