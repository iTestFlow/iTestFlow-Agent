import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  getReviewContext: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireWorkflowRole: mocks.requireWorkflowRole,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/rag/project-knowledge-draft.service", () => ({
  getProjectKnowledgeDraftReviewContext: mocks.getReviewContext,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const params = { params: Promise.resolve({ draftId: "draft-1" }) };

describe("POST /api/context/knowledge/drafts/[draftId]/review-context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getReviewContext.mockResolvedValue({ entries: [] });
  });

  it("rejects malformed scope before loading dependencies", async () => {
    const response = await POST(jsonRequest("/review-context", { scope: null }), params);
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON before loading dependencies", async () => {
    const response = await POST(new Request("http://localhost/review-context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }), params);
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires an owner or admin", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Owner required.", 403));
    const response = await POST(jsonRequest("/review-context", {
      scope: { ...trustedScope, workspaceId: "workspace-1" },
    }), params);
    expect(response.status).toBe(403);
    expect(mocks.getReviewContext).not.toHaveBeenCalled();
  });

  it("loads review sources under the trusted project scope", async () => {
    const reviewContext = {
      entries: [{
        category: "module",
        entryKey: "checkout",
        sources: [{
          sourceSnapshotId: "snapshot-42",
          sourceWorkItemId: "42",
          fields: [{ sourceField: "description", text: "Checkout is secure." }],
        }],
      }],
    };
    mocks.getReviewContext.mockResolvedValue(reviewContext);
    const response = await POST(jsonRequest("/review-context", {
      scope: { ...trustedScope, workspaceId: "workspace-1" },
    }), params);

    expect(response.status).toBe(200);
    expect(mocks.getReviewContext).toHaveBeenCalledWith({ scope: trustedScope, draftId: "draft-1" });
    expect(await response.json()).toEqual({ reviewContext });
  });

  it("returns 404 when the draft is outside the resolved project", async () => {
    mocks.getReviewContext.mockResolvedValue(null);
    const response = await POST(jsonRequest("/review-context", {
      scope: { ...trustedScope, workspaceId: "workspace-1" },
    }), params);
    expect(response.status).toBe(404);
  });

  it("returns the stable route error when review context loading fails", async () => {
    mocks.getReviewContext.mockRejectedValue(new Error("database unavailable"));
    const response = await POST(jsonRequest("/review-context", {
      scope: { ...trustedScope, workspaceId: "workspace-1" },
    }), params);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "The service is temporarily unavailable. Try again in a moment." });
  });
});
