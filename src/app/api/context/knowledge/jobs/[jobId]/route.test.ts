import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(), requireWorkflowRole: vi.fn(), getJob: vi.fn(), cancelJob: vi.fn(),
}));
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/jobs/project-knowledge-jobs.service", () => ({
  getProjectKnowledgeJob: mocks.getJob, cancelProjectKnowledgeJob: mocks.cancelJob,
}));

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { DELETE, GET } from "./route";

const params = { params: Promise.resolve({ jobId: "job-1" }) };
const url = "http://localhost/jobs/job-1?workspaceId=workspace-1&projectId=project-1";

describe("GET/DELETE project knowledge job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "member-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.getJob.mockResolvedValue({ id: "job-1", phase: "queued" });
    mocks.cancelJob.mockResolvedValue({ id: "job-1", cancellation: { requested: true } });
  });

  it("requires workspace and project query scope", async () => {
    expect((await GET(new Request("http://localhost/jobs/job-1"), params)).status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("lets a workspace member read a sanitized job", async () => {
    const response = await GET(new Request(url), params);
    expect(response.status).toBe(200);
    expect(mocks.getJob).toHaveBeenCalledWith({ id: "job-1", workspaceId: "workspace-1", projectId: "project-1" });
    expect(await response.json()).toEqual({ job: { id: "job-1", phase: "queued" } });
  });

  it("requires owner or admin to cancel", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    expect((await DELETE(new Request(url, { method: "DELETE" }), params)).status).toBe(403);
    expect(mocks.cancelJob).not.toHaveBeenCalled();
  });

  it("requests cooperative cancellation and returns 404 for unknown jobs", async () => {
    const response = await DELETE(new Request(url, { method: "DELETE" }), params);
    expect(response.status).toBe(200);
    expect(mocks.cancelJob).toHaveBeenCalledWith({ id: "job-1", workspaceId: "workspace-1", projectId: "project-1" });
    mocks.getJob.mockResolvedValue(null);
    expect((await GET(new Request(url), params)).status).toBe(404);
  });
});
