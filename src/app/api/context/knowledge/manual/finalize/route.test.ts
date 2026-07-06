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
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const body = {
  scope: { ...trustedScope, workspaceId: "ws-1" },
  mode: "full",
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

  it("rejects malformed or incomplete full-mode batches", async () => {
    const malformed = await POST(new Request("http://localhost/api/context/knowledge/manual/finalize", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }));
    expect(malformed.status).toBe(400);
    const invalid = await POST(jsonRequest("/api/context/knowledge/manual/finalize", {
      scope: body.scope,
      mode: "full",
      partialKnowledgeBases: [],
    }));
    expect(invalid.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
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
      mode: "full",
      partialKnowledgeBases: [{
        modules: [],
        businessRules: [],
        stateTransitions: [],
        glossary: [],
        crossDependencies: [],
      }],
    });
    expect(await response.json()).toMatchObject({ snapshot: { id: "kb-1" } });
  });

  it("maps finalization failures to 422", async () => {
    mocks.saveManualProjectKnowledgeBaseFromBatches.mockRejectedValue(new Error("Batch conflict"));
    const response = await POST(jsonRequest("/api/context/knowledge/manual/finalize", body));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Batch conflict" });
  });
});
