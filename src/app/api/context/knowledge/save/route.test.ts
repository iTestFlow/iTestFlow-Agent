import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  publishReviewedProjectKnowledge: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/rag/project-knowledge-actions.service", () => ({
  publishReviewedProjectKnowledge: mocks.publishReviewedProjectKnowledge,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const body = { scope: { ...trustedScope, workspaceId: "ws-1" }, draftId: "draft-1" };

describe("POST /api/context/knowledge/save compatibility adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.publishReviewedProjectKnowledge.mockResolvedValue({ outcome: "published", draftId: "draft-1", freshness: "current" });
  });

  it("rejects malformed or incomplete requests before authentication", async () => {
    const malformed = await POST(new Request("http://localhost/api/context/knowledge/save", {
      method: "POST", body: "{", headers: { "content-type": "application/json" },
    }));
    const incomplete = await POST(jsonRequest("/api/context/knowledge/save", { scope: body.scope }));
    expect(malformed.status).toBe(400);
    expect(incomplete.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires owner or admin", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    const response = await POST(jsonRequest("/api/context/knowledge/save", body));
    expect(response.status).toBe(403);
    expect(mocks.publishReviewedProjectKnowledge).not.toHaveBeenCalled();
  });

  it("publishes the exact draft synchronously", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/save", body));
    expect(response.status).toBe(200);
    expect(mocks.publishReviewedProjectKnowledge).toHaveBeenCalledWith({
      scope: trustedScope,
      actor: "user-1",
      draftId: "draft-1",
    });
    expect(await response.json()).toEqual({ outcome: "published", draftId: "draft-1", freshness: "current" });
  });
});
