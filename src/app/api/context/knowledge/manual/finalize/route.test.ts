import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  finalizeManualProjectKnowledge: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/rag/project-knowledge-actions.service", () => ({
  finalizeManualProjectKnowledge: mocks.finalizeManualProjectKnowledge,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const body = {
  scope: { ...trustedScope, workspaceId: "ws-1" },
  mode: "full" as const,
  draftId: "draft-1",
  partialKnowledgeBases: [{ untrusted: "ignored" }],
};

describe("POST /api/context/knowledge/manual/finalize compatibility adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.finalizeManualProjectKnowledge.mockResolvedValue({ outcome: "ready_to_publish", draftId: "draft-1" });
  });

  it("rejects malformed requests before authentication", async () => {
    const response = await POST(new Request("http://localhost/api/context/knowledge/manual/finalize", {
      method: "POST", body: "{", headers: { "content-type": "application/json" },
    }));
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires owner or admin", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    const response = await POST(jsonRequest("/api/context/knowledge/manual/finalize", body));
    expect(response.status).toBe(403);
    expect(mocks.finalizeManualProjectKnowledge).not.toHaveBeenCalled();
  });

  it("finalizes validated batches synchronously and ignores client knowledge copies", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/manual/finalize", body));
    expect(response.status).toBe(200);
    expect(mocks.finalizeManualProjectKnowledge).toHaveBeenCalledWith({
      scope: trustedScope,
      actor: "user-1",
      draftId: "draft-1",
      mode: "full",
    });
    expect(await response.json()).toEqual({ outcome: "ready_to_publish", draftId: "draft-1" });
  });
});
