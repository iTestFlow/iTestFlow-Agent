import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  abandonDraft: vi.fn(),
  getDraft: vi.fn(),
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
  abandonProjectKnowledgeDraft: mocks.abandonDraft,
  getProjectKnowledgeDraft: mocks.getDraft,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { PATCH } from "./route";

const trustedScope = projectScope();
const scope = { ...trustedScope, workspaceId: "workspace-1" };
const params = { params: Promise.resolve({ draftId: "draft-1" }) };

describe("PATCH /api/context/knowledge/drafts/[draftId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.abandonDraft.mockResolvedValue({
      id: "draft-1",
      persistedStatus: "superseded",
      supersededReason: "abandoned_by_user",
    });
  });

  it("rejects unsupported draft actions before authentication", async () => {
    const response = await PATCH(jsonRequest("/api/context/knowledge/drafts/draft-1", {
      scope,
      action: "delete",
    }), params);

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires owners or admins to abandon a draft", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Owner required.", 403));

    const response = await PATCH(jsonRequest("/api/context/knowledge/drafts/draft-1", {
      scope,
      action: "abandon",
    }), params);

    expect(response.status).toBe(403);
    expect(mocks.abandonDraft).not.toHaveBeenCalled();
  });

  it("abandons the draft under trusted project scope and actor", async () => {
    const response = await PATCH(jsonRequest("/api/context/knowledge/drafts/draft-1", {
      scope,
      action: "abandon",
    }), params);

    expect(response.status).toBe(200);
    expect(mocks.abandonDraft).toHaveBeenCalledWith({
      scope: trustedScope,
      draftId: "draft-1",
      actor: "owner-1",
    });
    expect(await response.json()).toMatchObject({
      draft: { persistedStatus: "superseded", supersededReason: "abandoned_by_user" },
    });
  });
});
