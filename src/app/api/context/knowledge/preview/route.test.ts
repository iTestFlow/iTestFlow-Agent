import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  requireWorkflowRole: vi.fn(),
  resolveProjectScope: vi.fn(),
  enqueueProjectKnowledgeJob: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext, requireWorkflowRole: mocks.requireWorkflowRole };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: mocks.resolveProjectScope }));
vi.mock("@/modules/jobs/project-knowledge-jobs.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/jobs/project-knowledge-jobs.service")>();
  return { ...actual, enqueueProjectKnowledgeJob: mocks.enqueueProjectKnowledgeJob };
});

import { WorkflowAuthError } from "@/modules/credentials/scoped-resolution.service";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { jsonRequest, projectScope } from "@/test/factories";
import { POST } from "./route";

const trustedScope = projectScope();
const body = { scope: { ...trustedScope, workspaceId: "ws-1" }, mode: "incremental" as const };

describe("POST /api/context/knowledge/preview compatibility adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "user-1", workspace: { id: "ws-1" } });
    mocks.requireWorkflowRole.mockResolvedValue(undefined);
    mocks.resolveProjectScope.mockResolvedValue(trustedScope);
    mocks.enqueueProjectKnowledgeJob.mockResolvedValue({ job: { id: "job-1", status: "queued" }, reused: false });
  });

  it("rejects malformed JSON before authentication", async () => {
    const response = await POST(new Request("http://localhost/api/context/knowledge/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Please select a project before building knowledge." });
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("requires an owner or admin", async () => {
    mocks.requireWorkflowRole.mockRejectedValue(new WorkflowAuthError("Admin required.", 403));
    const response = await POST(jsonRequest("/api/context/knowledge/preview", body));
    expect(response.status).toBe(403);
    expect(mocks.enqueueProjectKnowledgeJob).not.toHaveBeenCalled();
  });

  it("queues a background build and returns 202", async () => {
    const response = await POST(jsonRequest("/api/context/knowledge/preview", body));
    expect(response.status).toBe(202);
    expect(mocks.enqueueProjectKnowledgeJob).toHaveBeenCalledWith({
      scope: trustedScope,
      workspaceId: "ws-1",
      actor: "user-1",
      operation: "build",
      mode: "incremental",
    });
    expect(await response.json()).toEqual({ job: { id: "job-1", status: "queued" }, reused: false });
  });

  it("preserves queue state conflicts", async () => {
    mocks.enqueueProjectKnowledgeJob.mockRejectedValue(new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "A project knowledge operation is active.",
      userMessage: "Wait for the active operation to finish.",
    }));
    const response = await POST(jsonRequest("/api/context/knowledge/preview", body));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: AppErrorCode.KnowledgeDraftConflict });
  });

  it("returns a retryable 503 when generation capacity is unavailable", async () => {
    mocks.enqueueProjectKnowledgeJob.mockRejectedValue(Object.assign(
      new Error("Knowledge generation is temporarily unavailable."),
      { code: "knowledge_build_unavailable" },
    ));
    const response = await POST(jsonRequest("/api/context/knowledge/preview", body));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("5");
  });
});
