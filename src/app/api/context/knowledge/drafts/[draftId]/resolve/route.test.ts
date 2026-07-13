import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  resolveProjectKnowledgeDraft: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireWorkflowRole: mocks.requireWorkflowRole,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-knowledge-draft.service", () => ({
  resolveProjectKnowledgeDraft: mocks.resolveProjectKnowledgeDraft,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const body = {
  scope: { ...trustedScope, workspaceId: "workspace-1" },
  proposedKnowledge: {
    modules: [],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
  },
};
const params = { params: Promise.resolve({ draftId: "draft-1" }) };

describe("POST /api/context/knowledge/drafts/[draftId]/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.resolveProjectKnowledgeDraft.mockResolvedValue({ id: "draft-1", persistedStatus: "ready_for_review" });
  });

  it("rejects malformed proposals before loading the route dependencies", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/drafts/draft-1/resolve", {
      scope: body.scope,
      proposedKnowledge: { modules: [{ id: "invalid" }] },
    }), params);

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
    expect(mocks.resolveProjectKnowledgeDraft).not.toHaveBeenCalled();
  });

  it("requires an owner or admin before resolving the draft", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Owner required.", 403));

    const response = await POST(jsonRequest("/api/context/knowledge/drafts/draft-1/resolve", body), params);

    expect(response.status).toBe(403);
    expect(mocks.resolveProjectScope).not.toHaveBeenCalled();
    expect(mocks.resolveProjectKnowledgeDraft).not.toHaveBeenCalled();
  });

  it("resolves the reviewed proposal under trusted scope and actor", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/drafts/draft-1/resolve", body), params);

    expect(response.status).toBe(200);
    expect(mocks.resolveProjectKnowledgeDraft).toHaveBeenCalledWith({
      scope: trustedScope,
      actor: "owner-1",
      draftId: "draft-1",
      proposedKnowledge: body.proposedKnowledge,
    });
    expect(await response.json()).toEqual({
      draft: { id: "draft-1", persistedStatus: "ready_for_review" },
    });
  });
});
