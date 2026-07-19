import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(), requireWorkflowRole: vi.fn(), resolveProjectScope: vi.fn(), applyDecisions: vi.fn(),
}));
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/rag/project-knowledge-actions.service", () => ({ applyKnowledgeConflictDecisions: mocks.applyDecisions }));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const scope = projectScope();
const params = { params: Promise.resolve({ draftId: "draft-1" }) };
const body = {
  scope: { ...scope, workspaceId: "workspace-1" }, draftVersion: "version-1",
  decisions: [{ conflictId: "conflict-1", action: "combine", fieldParticipants: { rule: "participant-1" } }],
};

describe("POST compact conflict decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(scope);
    mocks.applyDecisions.mockResolvedValue({ outcome: "ready_to_publish", draftId: "draft-1" });
  });

  it("rejects empty or free-form decisions before authentication", async () => {
    const malformedJson = await POST(new Request("http://localhost/decisions", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }), params);
    expect(malformedJson.status).toBe(400);
    expect((await POST(jsonRequest("/decisions", { ...body, decisions: [] }), params)).status).toBe(400);
    expect((await POST(jsonRequest("/decisions", { ...body, decisions: [{ conflictId: "c", action: "edit", text: "invent" }] }), params)).status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires owner or admin", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    expect((await POST(jsonRequest("/decisions", body), params)).status).toBe(403);
    expect(mocks.applyDecisions).not.toHaveBeenCalled();
  });

  it("applies compact decisions synchronously", async () => {
    const response = await POST(jsonRequest("/decisions", body), params);
    expect(response.status).toBe(200);
    expect(mocks.applyDecisions).toHaveBeenCalledWith({
      scope, actor: "owner-1",
      draftId: "draft-1", draftVersion: "version-1", decisions: body.decisions,
    });
    expect(await response.json()).toEqual({ outcome: "ready_to_publish", draftId: "draft-1" });
  });
});
