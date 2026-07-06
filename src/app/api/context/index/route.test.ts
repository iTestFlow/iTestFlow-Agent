import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  getUserAzureAdapter: vi.fn(),
  indexAzureWorkItemsAsProjectContext: vi.fn(),
  startWorkflowRun: vi.fn(() => "run-1"),
  completeWorkflowRun: vi.fn(),
  failWorkflowRun: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return {
    ...actual,
    requireWorkflowContext: mocks.requireWorkflowContext,
    requireWorkflowRole: mocks.requireWorkflowRole,
    getUserAzureAdapter: mocks.getUserAzureAdapter,
  };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/rag/project-context-store.service", () => ({
  indexAzureWorkItemsAsProjectContext: mocks.indexAzureWorkItemsAsProjectContext,
}));
vi.mock("@/modules/analytics/workflow-analytics.service", () => ({
  startWorkflowRun: mocks.startWorkflowRun,
  completeWorkflowRun: mocks.completeWorkflowRun,
  failWorkflowRun: mocks.failWorkflowRun,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { fakeAzureAdapter, jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const validBody = {
  scope: { ...trustedScope, workspaceId: "ws-1" },
  workItemTypes: ["User Story"],
  states: ["Active"],
  mode: "rebuild",
};

describe("POST /api/context/index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.startWorkflowRun.mockReturnValue("run-1");
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.getUserAzureAdapter.mockResolvedValue(fakeAzureAdapter());
    mocks.indexAzureWorkItemsAsProjectContext.mockResolvedValue({
      fetchedCount: 4,
      indexedWorkItemCount: 3,
      indexedChunkCount: 6,
    });
  });

  it("rejects malformed or incomplete input before authorization", async () => {
    const malformed = await POST(new Request("http://localhost/api/context/index", {
      method: "POST",
      body: "{",
      headers: { "content-type": "application/json" },
    }));
    expect(malformed.status).toBe(400);

    const invalid = await POST(jsonRequest("/api/context/index", { ...validBody, states: [] }));
    expect(invalid.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires an administrative role before resolving project scope", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    const response = await POST(jsonRequest("/api/context/index", validBody));
    expect(response.status).toBe(403);
    expect(mocks.resolveProjectScope).not.toHaveBeenCalled();
  });

  it("indexes the trusted scope and completes analytics from persisted counts", async () => {
    const response = await POST(jsonRequest("/api/context/index", validBody));
    expect(response.status).toBe(200);
    expect(mocks.indexAzureWorkItemsAsProjectContext).toHaveBeenCalledWith({
      scope: trustedScope,
      actor: "user-1",
      adapter: expect.anything(),
      workItemTypes: ["User Story"],
      states: ["Active"],
      mode: "rebuild",
    });
    expect(mocks.completeWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      valueRealized: true,
      patch: {
        itemsGenerated: 3,
        itemsSelected: 4,
        itemsPublished: 3,
        metadata: { knowledge: { indexedWorkItemCount: 3, indexedChunkCount: 6 } },
      },
    });
    expect(await response.json()).toMatchObject({ source: "live", analyticsRunId: "run-1" });
  });

  it("fails an established analytics run on downstream rejection", async () => {
    mocks.indexAzureWorkItemsAsProjectContext.mockRejectedValue(new Error("Index failed"));
    const response = await POST(jsonRequest("/api/context/index", validBody));
    expect(response.status).toBe(503);
    expect(mocks.failWorkflowRun).toHaveBeenCalledWith({
      scope: trustedScope,
      runId: "run-1",
      error: "Index failed",
    });
  });
});
