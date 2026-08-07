import "server-only";

import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  enqueueJob,
  failPendingJob,
  findActiveJob,
  getJob,
  requestJobCancellation,
  type Job,
} from "./job-queue.service";
import { hasHealthyWorkerCapability } from "./worker-registry.service";

export const TEST_EXECUTION_RUN = "test_execution_run";
export const TEST_EXECUTION_UNAVAILABLE_CODE = "test_execution_unavailable";
export const TEST_EXECUTION_UNAVAILABLE_MESSAGE =
  "Test execution is temporarily unavailable. Please try again shortly.";
export const TEST_EXECUTION_PENDING_CAPACITY_GRACE_MS = 30_000;

export class TestExecutionUnavailableError extends Error {
  readonly code = TEST_EXECUTION_UNAVAILABLE_CODE;

  constructor() {
    super(TEST_EXECUTION_UNAVAILABLE_MESSAGE);
    this.name = "TestExecutionUnavailableError";
  }
}

export function isTestExecutionUnavailableError(error: unknown): error is TestExecutionUnavailableError {
  return error instanceof TestExecutionUnavailableError || (
    Boolean(error) && typeof error === "object" &&
    (error as { code?: unknown }).code === TEST_EXECUTION_UNAVAILABLE_CODE
  );
}

/**
 * Enqueue the browser-execution job for an approved run. Browser jobs are
 * maxAttempts=1 — a failed TEST is a completed JOB (the handler returns
 * terminal outcomes), and a partially executed state-changing workflow must
 * never replay silently. The dedupe key gives one active run per project.
 */
export async function enqueueTestExecutionRunJob(input: {
  scope: ProjectScope;
  workspaceId: string;
  actor: string;
  runId: string;
}) {
  if (!await hasHealthyWorkerCapability(TEST_EXECUTION_RUN)) {
    throw new TestExecutionUnavailableError();
  }
  const dedupeKey = `test_execution:${input.scope.projectId}`;
  const id = await enqueueJob({
    jobType: TEST_EXECUTION_RUN,
    workspaceId: input.workspaceId,
    projectId: input.scope.projectId,
    payload: { projectId: input.scope.projectId, runId: input.runId },
    progress: { phase: "queued", percent: 0, runId: input.runId },
    dedupeKey,
    createdByUserId: input.actor,
    maxAttempts: 1,
  });
  const job = id
    ? await getJob({ id, workspaceId: input.workspaceId, projectId: input.scope.projectId })
    : await findActiveJob({
      workspaceId: input.workspaceId,
      projectId: input.scope.projectId,
      jobType: TEST_EXECUTION_RUN,
      dedupeKey,
    });
  if (!job) throw new Error("The test execution job could not be queued or reused.");
  return { job: sanitizeTestExecutionJob(job), reused: !id };
}

export async function getTestExecutionJob(input: {
  id: string;
  workspaceId: string;
  projectId: string;
}) {
  let job = await getJob(input);
  if (job?.jobType !== TEST_EXECUTION_RUN) return null;
  if (job.status === "pending" && pendingAgeMs(job.createdAt) >= TEST_EXECUTION_PENDING_CAPACITY_GRACE_MS) {
    const available = await hasHealthyWorkerCapability(TEST_EXECUTION_RUN);
    if (!available && await failPendingJob(job.id, TEST_EXECUTION_UNAVAILABLE_MESSAGE)) {
      job = await getJob(input);
    }
  }
  return job?.jobType === TEST_EXECUTION_RUN ? sanitizeTestExecutionJob(job) : null;
}

export async function cancelTestExecutionJob(input: {
  id: string;
  workspaceId: string;
  projectId: string;
}) {
  const job = await requestJobCancellation(input);
  return job?.jobType === TEST_EXECUTION_RUN ? sanitizeTestExecutionJob(job) : null;
}

export function sanitizeTestExecutionJob(job: Job) {
  const progress = job.progress ?? {};
  const result = job.result ?? null;
  return {
    id: job.id,
    status: job.status,
    runId: typeof job.payload.runId === "string" ? job.payload.runId : null,
    phase: typeof progress.phase === "string" ? progress.phase : job.status,
    progress: Object.fromEntries(Object.entries(progress).filter(([key]) =>
      ["phase", "percent", "runId", "caseIndex", "caseTotal", "caseTitle", "stepIndex", "stepTotal"].includes(key),
    )),
    result: result ? Object.fromEntries(Object.entries(result).filter(([key]) =>
      ["outcome", "runId", "totalCases", "executedCases"].includes(key),
    )) : null,
    cancellation: { requested: Boolean(job.cancelRequestedAt), requestedAt: job.cancelRequestedAt },
    error: job.status === "failed" ? job.errorMessage : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function pendingAgeMs(createdAt: string) {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0;
}
