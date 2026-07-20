import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  rejectCandidate: vi.fn(),
  requestIntegration: vi.fn(),
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
  rejectProjectKnowledgeCandidate: mocks.rejectCandidate,
  requestProjectKnowledgeCandidateIntegration: mocks.requestIntegration,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { PATCH } from "./route";

const scope = { ...projectScope(), workspaceId: "workspace-1" };
const params = { params: Promise.resolve({ candidateId: "candidate-1" }) };

describe("project knowledge candidate permissions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "member-1",
      workspace: { id: "workspace-1" },
      membership: { role: "member" },
    });
    mocks.resolveProjectScope.mockResolvedValue(projectScope());
    mocks.rejectCandidate.mockResolvedValue({ id: "candidate-1", status: "rejected" });
    mocks.requestIntegration.mockResolvedValue({ id: "candidate-1", status: "integration_requested" });
  });

  it("blocks member candidate mutations before invoking the service", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Owner required.", 403));
    const response = await PATCH(jsonRequest("/api/context/knowledge/candidates/candidate-1", {
      scope,
      action: "reject",
      reason: "Not supported",
    }), params);
    expect(response.status).toBe(403);
    expect(mocks.rejectCandidate).not.toHaveBeenCalled();
  });

  it("allows owners and admins to request integration", async () => {
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    const response = await PATCH(jsonRequest("/api/context/knowledge/candidates/candidate-1", {
      scope,
      action: "request_integration",
    }), params);
    expect(response.status).toBe(200);
    expect(mocks.requestIntegration).toHaveBeenCalledWith({
      scope: projectScope(),
      candidateId: "candidate-1",
      actor: "member-1",
    });
  });
});
