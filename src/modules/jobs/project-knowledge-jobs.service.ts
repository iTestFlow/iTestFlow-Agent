import "server-only";

import { z } from "zod";

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
import { withProjectKnowledgeOperationGate } from "./project-knowledge-operation-gate";

export const PROJECT_KNOWLEDGE_JOB = "project_knowledge_v4";
export const PROJECT_KNOWLEDGE_PENDING_CAPACITY_GRACE_MS = 30_000;
export const KNOWLEDGE_BUILD_UNAVAILABLE_CODE = "knowledge_build_unavailable";
export const KNOWLEDGE_BUILD_UNAVAILABLE_MESSAGE = "Knowledge generation is temporarily unavailable. Please try again shortly.";

export class KnowledgeBuildUnavailableError extends Error {
  readonly code = KNOWLEDGE_BUILD_UNAVAILABLE_CODE;

  constructor() {
    super(KNOWLEDGE_BUILD_UNAVAILABLE_MESSAGE);
    this.name = "KnowledgeBuildUnavailableError";
  }
}

export function isKnowledgeBuildUnavailableError(error: unknown): error is KnowledgeBuildUnavailableError {
  return error instanceof KnowledgeBuildUnavailableError || (
    Boolean(error) && typeof error === "object" &&
    (error as { code?: unknown }).code === KNOWLEDGE_BUILD_UNAVAILABLE_CODE
  );
}

export const ProjectKnowledgeConflictDecisionSchema = z.discriminatedUnion("action", [
  z.object({
    conflictId: z.string().min(1),
    action: z.literal("keep"),
    participantId: z.string().min(1),
  }),
  z.object({
    conflictId: z.string().min(1),
    action: z.literal("combine"),
    fieldParticipants: z.record(z.string(), z.string().min(1)),
  }),
]);

export async function enqueueProjectKnowledgeJob(input: {
  scope: ProjectScope;
  workspaceId: string;
  actor: string;
  operation: "build";
  mode?: "incremental" | "full";
}) {
  return withProjectKnowledgeOperationGate(
    { ...input.scope, workspaceId: input.workspaceId },
    input.operation,
    () => enqueueProjectKnowledgeJobInsideGate(input),
  );
}

async function enqueueProjectKnowledgeJobInsideGate(input: {
  scope: ProjectScope;
  workspaceId: string;
  actor: string;
  operation: "build";
  mode?: "incremental" | "full";
}) {
  if (input.operation === "build" && !await hasHealthyWorkerCapability(PROJECT_KNOWLEDGE_JOB)) {
    throw new KnowledgeBuildUnavailableError();
  }
  const dedupeKey = `project_knowledge:${input.scope.projectId}`;
  const payload = {
    projectId: input.scope.projectId,
    operation: input.operation,
    ...(input.mode ? { mode: input.mode } : {}),
  };
  const id = await enqueueJob({
    jobType: PROJECT_KNOWLEDGE_JOB,
    workspaceId: input.workspaceId,
    projectId: input.scope.projectId,
    payload,
    progress: { phase: "queued", operation: input.operation },
    dedupeKey,
    createdByUserId: input.actor,
    maxAttempts: 3,
  });
  const job = id
    ? await getJob({ id, workspaceId: input.workspaceId, projectId: input.scope.projectId })
    : await findActiveJob({
        workspaceId: input.workspaceId,
        projectId: input.scope.projectId,
        jobType: PROJECT_KNOWLEDGE_JOB,
        dedupeKey,
      });
  if (!job) throw new Error("The project knowledge job could not be queued or reused.");
  return { job: sanitizeProjectKnowledgeJob(job), reused: !id };
}

export async function getProjectKnowledgeJob(input: {
  id: string;
  workspaceId: string;
  projectId: string;
}) {
  let job = await getJob(input);
  if (job?.jobType !== PROJECT_KNOWLEDGE_JOB) return null;
  if (job.status === "pending" && pendingAgeMs(job.createdAt) >= PROJECT_KNOWLEDGE_PENDING_CAPACITY_GRACE_MS) {
    const available = await hasHealthyWorkerCapability(PROJECT_KNOWLEDGE_JOB);
    if (!available && await failPendingJob(job.id, KNOWLEDGE_BUILD_UNAVAILABLE_MESSAGE)) {
      job = await getJob(input);
    }
  }
  return job?.jobType === PROJECT_KNOWLEDGE_JOB ? sanitizeProjectKnowledgeJob(job) : null;
}

export async function cancelProjectKnowledgeJob(input: {
  id: string;
  workspaceId: string;
  projectId: string;
}) {
  const job = await requestJobCancellation(input);
  return job?.jobType === PROJECT_KNOWLEDGE_JOB ? sanitizeProjectKnowledgeJob(job) : null;
}

export function sanitizeProjectKnowledgeJob(job: Job) {
  return {
    id: job.id,
    status: job.status,
    operation: typeof job.payload.operation === "string" ? job.payload.operation : "unknown",
    phase: typeof job.progress?.phase === "string" ? job.progress.phase : job.status,
    progress: sanitizeProgress(job.progress ?? {}),
    result: sanitizeResult(job.result),
    cancellation: {
      requested: Boolean(job.cancelRequestedAt),
      requestedAt: job.cancelRequestedAt,
    },
    error: job.status === "failed" ? job.errorMessage : null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function sanitizeProgress(progress: Record<string, unknown>) {
  const allowed = ["phase", "percent", "completed", "total", "draftId", "operation"];
  return Object.fromEntries(Object.entries(progress).filter(([key]) => allowed.includes(key)));
}

function sanitizeResult(result: Record<string, unknown> | null | undefined) {
  if (!result) return null;
  const allowed = [
    "outcome",
    "draftId",
    "draftStatus",
    "conflictCount",
    "possibleTensionCount",
    "omittedEntryCount",
    "omissionReasons",
    "warnings",
  ];
  return Object.fromEntries(Object.entries(result).filter(([key]) => allowed.includes(key)));
}

function pendingAgeMs(createdAt: string) {
  const created = Date.parse(createdAt);
  return Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0;
}
