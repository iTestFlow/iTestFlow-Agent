import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  getUserLLMProvider: vi.fn(),
  resolveProjectScope: vi.fn(),
  rebaseDraft: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireWorkflowRole: mocks.requireWorkflowRole,
    getUserLLMProvider: mocks.getUserLLMProvider,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-knowledge.service", () => ({
  rebaseProjectKnowledgeDraft: mocks.rebaseDraft,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { fakeLlmProvider, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const requestScope = { ...trustedScope, workspaceId: "workspace-1" };
const params = { params: Promise.resolve({ draftId: "draft-parent" }) };

describe("POST /api/context/knowledge/drafts/[draftId]/rebase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserLLMProvider.mockResolvedValue(fakeLlmProvider());
    mocks.rebaseDraft.mockResolvedValue({ id: "draft-child", persistedStatus: "published" });
  });

  it("rejects malformed scope before authentication", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/drafts/draft-parent/rebase", {
      scope: { workspaceId: "workspace-1" },
    }), params);

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires an owner or admin before rebasing", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Owner required.", 403));

    const response = await POST(jsonRequest("/api/context/knowledge/drafts/draft-parent/rebase", {
      scope: requestScope,
    }), params);

    expect(response.status).toBe(403);
    expect(mocks.rebaseDraft).not.toHaveBeenCalled();
  });

  it("passes trusted scope, actor, provider, and parent draft to orchestration", async () => {
    const provider = fakeLlmProvider();
    mocks.getUserLLMProvider.mockResolvedValue(provider);

    const response = await POST(jsonRequest("/api/context/knowledge/drafts/draft-parent/rebase", {
      scope: requestScope,
    }), params);

    expect(response.status).toBe(200);
    expect(mocks.rebaseDraft).toHaveBeenCalledWith({
      scope: trustedScope,
      actor: "owner-1",
      provider,
      parentDraftId: "draft-parent",
    });
    expect(await response.json()).toEqual({ draft: { id: "draft-child", persistedStatus: "published" } });
  });

  it("preserves draft state conflicts as 409", async () => {
    mocks.rebaseDraft.mockRejectedValue(new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "The parent changed.",
      userMessage: "Refresh the parent draft.",
    }));

    const response = await POST(jsonRequest("/api/context/knowledge/drafts/draft-parent/rebase", {
      scope: requestScope,
    }), params);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Refresh the parent draft.",
      code: AppErrorCode.KnowledgeDraftConflict,
    });
  });
});
