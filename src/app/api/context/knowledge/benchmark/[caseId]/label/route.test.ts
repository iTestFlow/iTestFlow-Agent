import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  labelCase: vi.fn(),
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
vi.mock("@/modules/rag/project-knowledge-benchmark.service", () => ({
  labelProjectKnowledgeBenchmarkCase: mocks.labelCase,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const scope = { ...projectScope(), workspaceId: "workspace-1" };
const params = { params: Promise.resolve({ caseId: "case-1" }) };
const url = "/api/context/knowledge/benchmark/case-1/label";

describe("benchmark case labeling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({
      userId: "admin-1",
      workspace: { id: "workspace-1" },
      membership: { role: "admin" },
    });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(projectScope());
    mocks.labelCase.mockResolvedValue({ id: "case-1", expectedWorkItemId: "1234" });
  });

  it("blocks members before invoking the service", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));

    const response = await POST(jsonRequest(url, { scope, expectedWorkItemId: "1234" }), params);

    expect(response.status).toBe(403);
    expect(mocks.labelCase).not.toHaveBeenCalled();
  });

  it("normalizes prefixed work item ids before storing", async () => {
    const response = await POST(jsonRequest(url, { scope, expectedWorkItemId: "AB#1234" }), params);

    expect(response.status).toBe(200);
    expect(mocks.labelCase).toHaveBeenCalledWith(expect.objectContaining({
      caseId: "case-1",
      expectedWorkItemId: "1234",
    }));
  });

  it("rejects a label no work item number can be extracted from", async () => {
    const response = await POST(jsonRequest(url, { scope, expectedWorkItemId: "not-an-id" }), params);

    expect(response.status).toBe(400);
    expect(mocks.labelCase).not.toHaveBeenCalled();
  });

  it("rejects a request carrying neither a work item id nor a snippet", async () => {
    // Without this, the write nulls the label while still stamping labeled_at/labeled_by.
    const response = await POST(jsonRequest(url, { scope }), params);

    expect(response.status).toBe(400);
    expect(mocks.labelCase).not.toHaveBeenCalled();
  });
});
