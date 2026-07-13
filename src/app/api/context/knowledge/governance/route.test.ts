import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  getGovernance: vi.fn(),
  startGa: vi.fn(),
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
  getProjectKnowledgeCompilerGovernance: mocks.getGovernance,
  startProjectKnowledgeMilestone3Ga: mocks.startGa,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { PATCH, POST } from "./route";

const trustedScope = projectScope();
const scope = { ...trustedScope, workspaceId: "workspace-1" };

describe("project knowledge governance route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getGovernance.mockResolvedValue({ milestone3GaStartedAt: null });
    mocks.startGa.mockResolvedValue({ milestone3GaStartedAt: "2026-07-13T10:00:00.000Z" });
  });

  it("allows members to read governance without a mutation role check", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/governance", { scope }));

    expect(response.status).toBe(200);
    expect(mocks.getGovernance).toHaveBeenCalledWith({ scope: trustedScope });
    expect(mocks.requireWorkflowRole).not.toHaveBeenCalled();
  });

  it("requires owners or admins to start the GA clock", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Owner required.", 403));

    const response = await PATCH(jsonRequest("/api/context/knowledge/governance", {
      scope,
      action: "start_milestone3_ga",
    }));

    expect(response.status).toBe(403);
    expect(mocks.startGa).not.toHaveBeenCalled();
  });

  it("starts the GA clock under trusted scope and authenticated actor", async () => {
    const response = await PATCH(jsonRequest("/api/context/knowledge/governance", {
      scope,
      action: "start_milestone3_ga",
    }));

    expect(response.status).toBe(200);
    expect(mocks.startGa).toHaveBeenCalledWith({ scope: trustedScope, actor: "owner-1" });
    expect(await response.json()).toMatchObject({ milestone3GaStartedAt: "2026-07-13T10:00:00.000Z" });
  });
});
