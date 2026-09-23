import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  resolveProjectScope: vi.fn(),
  resolveWorkflowContextWithoutLLM: vi.fn(),
  resolveRetrievalTopK: vi.fn(),
  loadProjectKnowledgeContext: vi.fn(),
  rankProjectKnowledgeForWorkItem: vi.fn(),
  getWorkspaceSettings: vi.fn(),
  buildTestCaseGenerationPromptDraft: vi.fn(),
  loadSelectedStoryAttachmentWorkflowContext: vi.fn(),
}));

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
vi.mock("@/modules/rag/auto-context-resolver.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/rag/auto-context-resolver.service")>(),
  resolveWorkflowContextWithoutLLM: mocks.resolveWorkflowContextWithoutLLM,
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
vi.mock("@/modules/workspace/workspace-settings.service", () => ({
  getWorkspaceSettings: mocks.getWorkspaceSettings,
}));
vi.mock("@/modules/test-case-design/application/test-case-generation.service", () => ({
  buildTestCaseGenerationPromptDraft: mocks.buildTestCaseGenerationPromptDraft,
}));
vi.mock("@/modules/story-attachments/story-attachment-workflow-context", () => ({
  loadSelectedStoryAttachmentWorkflowContext: mocks.loadSelectedStoryAttachmentWorkflowContext,
}));

import { azureDevOpsIntegrationError } from "@/modules/integrations/azure-devops/azure-devops-error";
import { fakeAzureAdapter, jsonRequest, projectScope, requirement } from "@/test/factories";
import { POST } from "./route";

/**
 * This endpoint lets a user copy the exact prompt an internal Run would send, without
 * calling an LLM. It had no test at all, so nothing guarded it staying in sync with the
 * generate route's own wiring: a silent divergence here means the copied prompt differs
 * from what production actually sends for the same work item.
 */

const trustedScope = projectScope();
const context = {
  userId: "user-1",
  workspace: { id: "ws-1", azureOrgUrl: "https://dev.azure.com/demo", providerId: "azure-devops" },
};

function body() {
  return { scope: { ...trustedScope, workspaceId: "ws-1" }, targetWorkItemId: "123" };
}

describe("test-cases manual draft route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue(context);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      fetchWorkItemById: vi.fn(async () => requirement({ id: "123", title: "Target" })),
    }));
    mocks.resolveRetrievalTopK.mockResolvedValue(6);
    mocks.resolveWorkflowContextWithoutLLM.mockResolvedValue({
      relatedWorkItems: [{ workItemId: "200" }],
      selectedContext: [{ workItemId: "201" }],
      contextUsed: [],
      retrievalTopK: 6,
    });
    mocks.loadProjectKnowledgeContext.mockResolvedValue({ knowledgeBase: {}, promptNotice: null });
    mocks.rankProjectKnowledgeForWorkItem.mockResolvedValue({ businessRules: ["rule-1"] });
    mocks.getWorkspaceSettings.mockResolvedValue({ externalLlmEnabled: true, modelInputTokenLimitOverride: 64_000 });
    mocks.buildTestCaseGenerationPromptDraft.mockReturnValue({
      prompt: "mock prompt",
      relevantProjectKnowledgeBase: null,
      includedStoryAttachmentTextIds: [],
      omittedStoryAttachmentTextIds: [],
      storyAttachmentWarnings: [],
    });
    mocks.loadSelectedStoryAttachmentWorkflowContext.mockResolvedValue({
      promptAttachments: [],
      citationAttachments: [],
      images: [],
      warnings: [],
    });
  });

  it("sends the workspace model window, the retrieval floor and the ranked knowledge it selected", async () => {
    // These three are what make the copied prompt match what an internal Run actually
    // sends for the same work item. Dropped once before between the service boundary
    // and the renderer, silently — this is the regression guard for that.
    const response = await POST(jsonRequest("/api/test-cases/manual/draft", body()));

    expect(response.status).toBe(200);
    expect(mocks.buildTestCaseGenerationPromptDraft).toHaveBeenCalledWith(expect.objectContaining({
      maxInputTokens: 64_000,
      relatedWorkItemsFloor: 6,
      rankedKnowledgeKeys: { businessRules: ["rule-1"] },
    }));
  });

  it("anchors knowledge ranking on the work items context actually resolved", async () => {
    // Ranking anchored on the target alone would miss knowledge reachable only through
    // the items retrieval just decided were relevant.
    await POST(jsonRequest("/api/test-cases/manual/draft", body()));

    expect(mocks.rankProjectKnowledgeForWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      contextWorkItemIds: ["200", "201"],
    }));
  });

  it("still produces a draft when knowledge ranking yields nothing", async () => {
    // Ranking is a refinement, never a dependency: returning null must fall back to
    // keyword ordering rather than fail the request.
    mocks.rankProjectKnowledgeForWorkItem.mockResolvedValue(null);

    const response = await POST(jsonRequest("/api/test-cases/manual/draft", body()));

    expect(response.status).toBe(200);
    expect(mocks.buildTestCaseGenerationPromptDraft).toHaveBeenCalledWith(expect.objectContaining({
      rankedKnowledgeKeys: undefined,
    }));
  });

  it("falls back to the default model window when the workspace has no override", async () => {
    mocks.getWorkspaceSettings.mockResolvedValue({ externalLlmEnabled: true, modelInputTokenLimitOverride: null });

    await POST(jsonRequest("/api/test-cases/manual/draft", body()));

    expect(mocks.buildTestCaseGenerationPromptDraft).toHaveBeenCalledWith(expect.objectContaining({
      maxInputTokens: undefined,
    }));
  });

  it("adds selected story attachment text and citations to the copied prompt", async () => {
    const promptAttachments = [{
      id: "attachment-1",
      fileName: "checkout.png",
      mimeType: "image/png",
      text: "Checkout form shows card number and confirmation button.",
      visualCount: 0,
    }];
    const citationAttachments = [{
      id: "attachment-1",
      fileName: "checkout.png",
      mimeType: "image/png",
      visualCount: 0,
    }];
    mocks.loadSelectedStoryAttachmentWorkflowContext.mockResolvedValue({
      promptAttachments,
      citationAttachments,
      images: [],
      warnings: ["Attachment visual bytes are omitted from copied prompts."],
    });
    mocks.buildTestCaseGenerationPromptDraft.mockReturnValue({
      prompt: "mock prompt",
      relevantProjectKnowledgeBase: null,
      includedStoryAttachmentTextIds: ["attachment-1"],
      omittedStoryAttachmentTextIds: [],
      storyAttachmentWarnings: [],
    });
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      fetchWorkItemById: vi.fn(async () => requirement({ id: "PAY-123", title: "Target", raw: { id: "10001" } })),
    }));

    const response = await POST(jsonRequest("/api/test-cases/manual/draft", {
      ...body(),
      attachmentIds: ["attachment-1"],
    }));

    expect(response.status).toBe(200);
    expect(mocks.loadSelectedStoryAttachmentWorkflowContext).toHaveBeenCalledWith({
      scope: {
        workspaceId: "ws-1",
        projectId: trustedScope.projectId,
        providerId: "azure-devops",
        canonicalStoryId: "10001",
        storyDisplayKey: "PAY-123",
      },
      attachmentIds: ["attachment-1"],
      includeVisuals: false,
      maxInputTokens: 64_000,
    });
    expect(mocks.buildTestCaseGenerationPromptDraft).toHaveBeenCalledWith(expect.objectContaining({
      storyAttachments: promptAttachments,
    }));
    await expect(response.json()).resolves.toMatchObject({
      warnings: ["Attachment visual bytes are omitted from copied prompts."],
      contextCitations: [expect.objectContaining({
        sourceType: "story_attachment",
        attachmentId: "attachment-1",
        fileName: "checkout.png",
      })],
    });
  });

  it("does not cite attachment text omitted from a copied prompt and reports the budget warning", async () => {
    const omittedAttachment = {
      id: "attachment-omitted",
      fileName: "large-specification.pdf",
      mimeType: "application/pdf",
      visualCount: 0,
    };
    mocks.loadSelectedStoryAttachmentWorkflowContext.mockResolvedValue({
      promptAttachments: [{ ...omittedAttachment, text: "This content did not fit." }],
      citationAttachments: [omittedAttachment],
      images: [],
      warnings: [],
    });
    mocks.buildTestCaseGenerationPromptDraft.mockReturnValue({
      prompt: "mock prompt",
      relevantProjectKnowledgeBase: null,
      includedStoryAttachmentTextIds: [],
      omittedStoryAttachmentTextIds: ["attachment-omitted"],
      storyAttachmentWarnings: [
        "Some selected attachment text was omitted to fit the model context window: large-specification.pdf.",
      ],
    });

    const response = await POST(jsonRequest("/api/test-cases/manual/draft", {
      ...body(),
      attachmentIds: ["attachment-omitted"],
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contextCitations: [],
      warnings: ["Some selected attachment text was omitted to fit the model context window: large-specification.pdf."],
    });
  });

  it("maps an integration auth failure to 401 with the integration scope header", async () => {
    mocks.resolveWorkflowContextWithoutLLM.mockRejectedValue(azureDevOpsIntegrationError(
      401,
      JSON.stringify({ message: "TF400813: not authorized" }),
      "_apis/wit/workitems/123?api-version=7.1",
    ));

    const response = await POST(jsonRequest("/api/test-cases/manual/draft", body()));

    expect(response.status).toBe(401);
    expect(response.headers.get("x-itf-error-scope")).toBe("integration");
  });

  it("rejects a request with no target work item before doing any work", async () => {
    const response = await POST(jsonRequest("/api/test-cases/manual/draft", {
      scope: { ...trustedScope, workspaceId: "ws-1" },
    }));

    expect(response.status).toBe(400);
    expect(mocks.resolveWorkflowContextWithoutLLM).not.toHaveBeenCalled();
  });

  it("rejects more than 20 selected story attachments before doing any work", async () => {
    const response = await POST(jsonRequest("/api/test-cases/manual/draft", {
      ...body(),
      attachmentIds: Array.from({ length: 21 }, (_, index) => `attachment-${index}`),
    }));

    expect(response.status).toBe(400);
    expect(mocks.getUserAzureAdapter).not.toHaveBeenCalled();
  });
});
