import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(), requireWorkflowRole: vi.fn(), resolveProjectScope: vi.fn(), enqueue: vi.fn(),
}));
vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/jobs/project-knowledge-jobs.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/jobs/project-knowledge-jobs.service")>();
  return { ...actual, enqueueProjectKnowledgeJob: mocks.enqueue };
});

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const scope = projectScope();
const requestScope = { ...scope, workspaceId: "workspace-1" };

describe("POST project knowledge jobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "owner-1", workspace: { id: "workspace-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(scope);
    mocks.enqueue.mockResolvedValue({ job: { id: "job-1" }, reused: false });
  });

  it("rejects malformed and every non-build operation", async () => {
    const malformedJson = await POST(new Request("http://localhost/jobs", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expect(malformedJson.status).toBe(400);
    expect((await POST(jsonRequest("/jobs", { scope: null, operation: "build" }))).status).toBe(400);
    expect((await POST(jsonRequest("/jobs", { scope: requestScope, operation: "apply_decisions" }))).status).toBe(400);
    expect((await POST(jsonRequest("/jobs", { scope: requestScope, operation: "publish" }))).status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires owner or admin", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    expect((await POST(jsonRequest("/jobs", { scope: requestScope, operation: "build" }))).status).toBe(403);
  });

  it("queues a validated build", async () => {
    const response = await POST(jsonRequest("/jobs", { scope: requestScope, operation: "build", mode: "full" }));
    expect(response.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith({
      scope, workspaceId: "workspace-1", actor: "owner-1", operation: "build", mode: "full",
    });
  });

  it("returns 503 without accepting a job when generation capacity is unavailable", async () => {
    mocks.enqueue.mockRejectedValue(Object.assign(new Error("Knowledge generation is temporarily unavailable."), {
      code: "knowledge_build_unavailable",
    }));
    const response = await POST(jsonRequest("/jobs", { scope: requestScope, operation: "build" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toMatchObject({ code: "knowledge_build_unavailable" });
  });
});
