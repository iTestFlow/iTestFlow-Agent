import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  saveManualProjectKnowledgeBaseFromBatches: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  saveManualProjectKnowledgeBaseFromBatches: mocks.saveManualProjectKnowledgeBaseFromBatches,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const body = {
  scope: { ...trustedScope, workspaceId: "ws-1" },
  mode: "full",
  draftId: "draft-1",
  partialKnowledgeBases: [{}],
};

describe("POST /api/context/knowledge/manual/finalize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.saveManualProjectKnowledgeBaseFromBatches.mockResolvedValue({
      id: "kb-1",
      knowledgeBase: { modules: [] },
    });
  });

  it("rejects malformed requests before authentication", async () => {
    const malformed = await POST(new Request("http://localhost/api/context/knowledge/manual/finalize", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }));
    expect(malformed.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("finalizes from persisted batches without client-supplied knowledge copies", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/manual/finalize", {
      scope: body.scope,
      mode: "full",
      draftId: "draft-1",
    }));
    expect(response.status).toBe(200);
    expect(mocks.saveManualProjectKnowledgeBaseFromBatches).toHaveBeenCalledWith({
      scope: trustedScope,
      actor: "user-1",
      draftId: "draft-1",
      mode: "full",
      partialKnowledgeBases: [],
    });
  });

  it("requires owner/admin before saving batches", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    const response = await POST(jsonRequest("/api/context/knowledge/manual/finalize", body));
    expect(response.status).toBe(403);
    expect(mocks.saveManualProjectKnowledgeBaseFromBatches).not.toHaveBeenCalled();
  });

  it("finalizes batches under trusted scope and authenticated actor", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/manual/finalize", body));
    expect(response.status).toBe(200);
    expect(mocks.saveManualProjectKnowledgeBaseFromBatches).toHaveBeenCalledWith({
      scope: trustedScope,
      actor: "user-1",
      draftId: "draft-1",
      mode: "full",
      partialKnowledgeBases: [{
        modules: [],
        businessRules: [],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      }],
    });
    expect(await response.json()).toMatchObject({ draft: { id: "kb-1" } });
  });

  it("does not flatten unexpected finalization failures into 422", async () => {
    mocks.saveManualProjectKnowledgeBaseFromBatches.mockRejectedValue(new Error("Batch conflict"));
    const response = await POST(jsonRequest("/api/context/knowledge/manual/finalize", body));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "External LLM knowledge base finalization failed.",
      technicalDetails: expect.stringContaining("Batch conflict"),
    });
  });

  it("preserves AppError state conflicts as 409", async () => {
    mocks.saveManualProjectKnowledgeBaseFromBatches.mockRejectedValue(new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "Draft changed.",
      userMessage: "Refresh the draft.",
    }));
    const response = await POST(jsonRequest("/api/context/knowledge/manual/finalize", body));
    expect(response.status).toBe(409);
  });
});
