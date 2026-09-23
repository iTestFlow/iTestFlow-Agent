import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  getUserLLMProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  prepareWorkflowContext: vi.fn(),
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
vi.mock("@/modules/rag/workflow-context-preparation.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/rag/workflow-context-preparation.service")>();
  return { ...actual, prepareWorkflowContext: mocks.prepareWorkflowContext };
});

import { fakeAzureAdapter, fakeLlmProvider, jsonRequest, projectScope, requirement } from "@/test/factories";
import { ContextReviewRequiredError } from "@/modules/rag/workflow-context-preparation.service";
import { POST } from "./route";

const trustedScope = projectScope();

function request(overrides: Record<string, unknown> = {}) {
  return jsonRequest("/api/workflow-context/preview", {
    workflow: "requirement_analysis",
    mode: "auto",
    scope: { ...trustedScope, workspaceId: "ws-1" },
    targetWorkItemId: "101",
    ...overrides,
  });
}

describe("POST /api/workflow-context/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "user-1",
      workspace: { id: "ws-1", providerId: "azure-devops" },
    });
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter({
      fetchWorkItemById: vi.fn(async () => requirement({ id: "101", title: "Target" })),
    }));
    mocks.getUserLLMProvider.mockResolvedValue(fakeLlmProvider());
    mocks.prepareWorkflowContext.mockResolvedValue({
      contextCitations: [{
        sourceType: "project_context",
        sourceId: "WI:200",
        title: "Related story",
        reason: "Similar to this story's content.",
        workItemId: "200",
        workItemType: "User Story",
      }],
      reviewedSourceIds: ["WI:200"],
      excludedSourceIds: [],
      contextConsistency: { valid: true, missingSourceIds: [] },
    });
  });

  it("returns freezeable memberships and carries existing exclusions into preview preparation", async () => {
    const response = await POST(request({ excludedSourceIds: ["WI:300"] }));

    expect(response.status).toBe(200);
    expect(mocks.prepareWorkflowContext).toHaveBeenCalledWith(expect.objectContaining({
      preview: true,
      workflow: "requirement_analysis",
      mode: "auto",
      excludedSourceIds: ["WI:300"],
      workspaceProviderId: "azure-devops",
    }));
    expect(await response.json()).toMatchObject({
      reviewedSourceIds: ["WI:200"],
      excludedSourceIds: [],
    });
  });

  it("returns a refresh-required conflict instead of calling an AI action", async () => {
    mocks.prepareWorkflowContext.mockRejectedValue(new ContextReviewRequiredError(["WI:200"]));

    const response = await POST(request({ reviewedSourceIds: ["WI:200"] }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "CONTEXT_REVIEW_REQUIRED",
      missingSourceIds: ["WI:200"],
    });
  });
});
