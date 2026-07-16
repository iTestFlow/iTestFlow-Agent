import { beforeEach, describe, expect, it, vi } from "vitest";

const queue = vi.hoisted(() => ({
  enqueueJob: vi.fn(),
  failPendingJob: vi.fn(),
  findActiveJob: vi.fn(),
  getJob: vi.fn(),
  requestJobCancellation: vi.fn(),
}));
vi.mock("./job-queue.service", () => queue);
const registry = vi.hoisted(() => ({ hasHealthyWorkerCapability: vi.fn() }));
vi.mock("./worker-registry.service", () => registry);
vi.mock("./project-knowledge-operation-gate", () => ({
  withProjectKnowledgeOperationGate: vi.fn((_scope, _operation, action) => action()),
}));

import { projectScope } from "@/test/factories";
import type { Job } from "./job-queue.service";
import {
  cancelProjectKnowledgeJob,
  enqueueProjectKnowledgeJob,
  getProjectKnowledgeJob,
  PROJECT_KNOWLEDGE_JOB,
  KNOWLEDGE_BUILD_UNAVAILABLE_CODE,
  ProjectKnowledgeConflictDecisionSchema,
  sanitizeProjectKnowledgeJob,
} from "./project-knowledge-jobs.service";

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    jobType: PROJECT_KNOWLEDGE_JOB,
    payload: { operation: "build", projectId: "project-1" },
    dedupeKey: "project_knowledge:project-1",
    status: "pending",
    priority: 100,
    attempts: 0,
    maxAttempts: 3,
    lockedBy: null,
    lockedAt: null,
    runAfter: "2026-07-15T00:00:00.000Z",
    errorMessage: null,
    createdByUserId: "owner-1",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    progress: { phase: "queued", percent: 0 },
    result: null,
    cancelRequestedAt: null,
    ...overrides,
  };
}

describe("project knowledge background job contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registry.hasHealthyWorkerCapability.mockResolvedValue(true);
    queue.failPendingJob.mockResolvedValue(true);
  });

  it("queues one project-scoped deduplicated job without credentials or full knowledge", async () => {
    queue.enqueueJob.mockResolvedValue("job-1");
    queue.getJob.mockResolvedValue(job());
    const scope = projectScope();
    const result = await enqueueProjectKnowledgeJob({
      scope,
      workspaceId: scope.workspaceId!,
      actor: "owner-1",
      operation: "build",
      mode: "incremental",
    });

    expect(queue.enqueueJob).toHaveBeenCalledWith(expect.objectContaining({
      jobType: PROJECT_KNOWLEDGE_JOB,
      projectId: scope.projectId,
      dedupeKey: `project_knowledge:${scope.projectId}`,
      createdByUserId: "owner-1",
      payload: {
        projectId: scope.projectId,
        operation: "build",
        mode: "incremental",
      },
    }));
    expect(JSON.stringify(queue.enqueueJob.mock.calls[0][0])).not.toMatch(/apiKey|credential|proposedKnowledge/i);
    expect(result.reused).toBe(false);
  });

  it("reuses the active project operation when the queue dedupe insert loses", async () => {
    queue.enqueueJob.mockResolvedValue(null);
    queue.findActiveJob.mockResolvedValue(job({ id: "job-active" }));
    const scope = projectScope();
    const result = await enqueueProjectKnowledgeJob({
      scope,
      workspaceId: scope.workspaceId!,
      actor: "owner-1",
      operation: "build",
    });
    expect(queue.findActiveJob).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `project_knowledge:${scope.projectId}`,
      jobType: PROJECT_KNOWLEDGE_JOB,
    }));
    expect(result).toMatchObject({ reused: true, job: { id: "job-active" } });
  });

  it("fails clearly if neither a new nor reusable job can be read", async () => {
    queue.enqueueJob.mockResolvedValue(null);
    queue.findActiveJob.mockResolvedValue(null);
    await expect(enqueueProjectKnowledgeJob({
      scope: projectScope(), workspaceId: "workspace-1", actor: "owner-1", operation: "build",
    })).rejects.toThrow("could not be queued or reused");
  });

  it("rejects a build before queue insertion when generation capacity is unavailable", async () => {
    registry.hasHealthyWorkerCapability.mockResolvedValue(false);
    await expect(enqueueProjectKnowledgeJob({
      scope: projectScope(), workspaceId: "workspace-1", actor: "owner-1", operation: "build",
    })).rejects.toMatchObject({ code: KNOWLEDGE_BUILD_UNAVAILABLE_CODE });
    expect(queue.enqueueJob).not.toHaveBeenCalled();
  });

  it("fails an orphaned pending job after the capacity grace period", async () => {
    registry.hasHealthyWorkerCapability.mockResolvedValue(false);
    queue.getJob
      .mockResolvedValueOnce(job({ createdAt: "2000-01-01T00:00:00.000Z" }))
      .mockResolvedValueOnce(job({ status: "failed", errorMessage: "Knowledge generation is temporarily unavailable." }));
    await expect(getProjectKnowledgeJob({ id: "job-1", workspaceId: "workspace-1", projectId: "project-1" }))
      .resolves.toMatchObject({ status: "failed" });
    expect(queue.failPendingJob).toHaveBeenCalledWith("job-1", expect.stringContaining("temporarily unavailable"));
  });

  it("returns and cancels only v4 project knowledge jobs in the requested project", async () => {
    queue.getJob.mockResolvedValue(job());
    queue.requestJobCancellation.mockResolvedValue(job({ status: "running", cancelRequestedAt: "2026-07-15T01:00:00.000Z" }));
    await expect(getProjectKnowledgeJob({ id: "job-1", workspaceId: "workspace-1", projectId: "project-1" }))
      .resolves.toMatchObject({ id: "job-1" });
    await expect(cancelProjectKnowledgeJob({ id: "job-1", workspaceId: "workspace-1", projectId: "project-1" }))
      .resolves.toMatchObject({ cancellation: { requested: true } });

    queue.getJob.mockResolvedValue(job({ jobType: "other" }));
    queue.requestJobCancellation.mockResolvedValue(job({ jobType: "other" }));
    await expect(getProjectKnowledgeJob({ id: "job-1", workspaceId: "workspace-1", projectId: "project-1" })).resolves.toBeNull();
    await expect(cancelProjectKnowledgeJob({ id: "job-1", workspaceId: "workspace-1", projectId: "project-1" })).resolves.toBeNull();
  });

  it("sanitizes progress and result summaries without exposing payloads or knowledge clones", () => {
    const sanitized = sanitizeProjectKnowledgeJob(job({
      status: "failed",
      errorMessage: "provider failed",
      progress: { phase: "validating_citations", percent: 80, tokenUsage: { secret: true }, draftId: "draft-1" },
      result: {
        outcome: "ready_to_publish",
        draftId: "draft-1",
        possibleTensionCount: 2,
        omittedEntryCount: 2,
        proposedKnowledge: { modules: [{ secret: true }] },
        rawOutput: "secret",
      },
    }));
    expect(sanitized).toMatchObject({
      phase: "validating_citations",
      progress: { phase: "validating_citations", percent: 80, draftId: "draft-1" },
      result: { outcome: "ready_to_publish", draftId: "draft-1", possibleTensionCount: 2, omittedEntryCount: 2 },
      error: "provider failed",
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/proposedKnowledge|rawOutput|tokenUsage|secret/);
  });

  it("accepts only compact keep/combine decisions", () => {
    expect(ProjectKnowledgeConflictDecisionSchema.safeParse({
      conflictId: "c1", action: "combine", fieldParticipants: { rule: "p1" },
    }).success).toBe(true);
    expect(ProjectKnowledgeConflictDecisionSchema.safeParse({
      conflictId: "c1", action: "edit", freeform: "invented text",
    }).success).toBe(false);
  });
});
