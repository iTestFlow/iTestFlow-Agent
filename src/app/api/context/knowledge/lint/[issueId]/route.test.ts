import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  transitionIssue: vi.fn(),
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
vi.mock("@/modules/rag/project-knowledge-compiled.service", () => ({
  transitionProjectKnowledgeLintIssue: mocks.transitionIssue,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { PATCH } from "./route";

const trustedScope = projectScope();
const scope = { ...trustedScope, workspaceId: "workspace-1" };
const params = { params: Promise.resolve({ issueId: "issue-1" }) };

describe("PATCH /api/context/knowledge/lint/[issueId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.transitionIssue.mockResolvedValue([{ id: "issue-1", status: "resolved" }]);
  });

  it("rejects unsupported transitions before authentication", async () => {
    const response = await PATCH(jsonRequest("/api/context/knowledge/lint/issue-1", {
      scope,
      action: "delete",
    }), params);

    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires owners or admins to mutate lint lifecycle", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Owner required.", 403));

    const response = await PATCH(jsonRequest("/api/context/knowledge/lint/issue-1", {
      scope,
      action: "ignore",
    }), params);

    expect(response.status).toBe(403);
    expect(mocks.transitionIssue).not.toHaveBeenCalled();
  });

  it.each(["confirm", "reject", "ignore", "reopen"] as const)(
    "passes the %s action under trusted project scope",
    async (action) => {
      const response = await PATCH(jsonRequest("/api/context/knowledge/lint/issue-1", {
        scope,
        action,
        note: "Reviewed",
      }), params);

      expect(response.status).toBe(200);
      expect(mocks.transitionIssue).toHaveBeenCalledWith({
        scope: trustedScope,
        actor: "owner-1",
        issueId: "issue-1",
        action,
        note: "Reviewed",
      });
    },
  );
});
