import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  saveGeneratedProjectKnowledgeBaseDraft: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  saveGeneratedProjectKnowledgeBaseDraft: mocks.saveGeneratedProjectKnowledgeBaseDraft,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const body = {
  scope: { ...trustedScope, workspaceId: "ws-1" },
  draftId: "draft-1",
};

describe("POST /api/context/knowledge/save", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.saveGeneratedProjectKnowledgeBaseDraft.mockResolvedValue({ id: "kb-1" });
  });

  it("returns 400 for malformed or incomplete previews", async () => {
    const malformed = await POST(new Request("http://localhost/api/context/knowledge/save", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }));
    expect(malformed.status).toBe(400);
    const invalid = await POST(jsonRequest("/api/context/knowledge/save", { scope: body.scope }));
    expect(invalid.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires owner/admin before resolving or saving", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    const response = await POST(jsonRequest("/api/context/knowledge/save", body));
    expect(response.status).toBe(403);
    expect(mocks.resolveProjectScope).not.toHaveBeenCalled();
  });

  it("saves under trusted scope and authenticated actor", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/save", body));
    expect(response.status).toBe(200);
    expect(mocks.saveGeneratedProjectKnowledgeBaseDraft).toHaveBeenCalledWith(
      expect.objectContaining({ scope: trustedScope, actor: "user-1" }),
    );
    expect(await response.json()).toEqual({ id: "kb-1" });
  });

  it("maps save failures to the route's validation status", async () => {
    mocks.saveGeneratedProjectKnowledgeBaseDraft.mockRejectedValue(new (await import("@/modules/shared/errors/app-error")).AppError({
      code: (await import("@/modules/shared/errors/app-error")).AppErrorCode.KnowledgeDraftConflict,
      message: "Revision conflict",
      userMessage: "Revision conflict",
    }));
    const response = await POST(jsonRequest("/api/context/knowledge/save", body));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "Revision conflict", code: "knowledge_draft_conflict" });
  });
});
