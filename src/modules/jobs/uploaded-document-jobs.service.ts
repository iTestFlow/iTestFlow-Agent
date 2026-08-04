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

export const UPLOADED_DOCUMENT_INGEST = "uploaded_document_ingest";
export const DOCUMENT_INGEST_UNAVAILABLE_CODE = "document_ingest_unavailable";
export const DOCUMENT_INGEST_UNAVAILABLE_MESSAGE = "Document processing is temporarily unavailable. Please try again shortly.";
export const DOCUMENT_INGEST_PENDING_CAPACITY_GRACE_MS = 30_000;

export class DocumentIngestUnavailableError extends Error {
  readonly code = DOCUMENT_INGEST_UNAVAILABLE_CODE;

  constructor() {
    super(DOCUMENT_INGEST_UNAVAILABLE_MESSAGE);
    this.name = "DocumentIngestUnavailableError";
  }
}

export function isDocumentIngestUnavailableError(error: unknown): error is DocumentIngestUnavailableError {
  return error instanceof DocumentIngestUnavailableError || (
    Boolean(error) && typeof error === "object" &&
    (error as { code?: unknown }).code === DOCUMENT_INGEST_UNAVAILABLE_CODE
  );
}

export async function enqueueUploadedDocumentIngestJob(input: {
  scope: ProjectScope;
  workspaceId: string;
  actor: string;
  versionId: string;
}) {
  if (!await hasHealthyWorkerCapability(UPLOADED_DOCUMENT_INGEST)) {
    throw new DocumentIngestUnavailableError();
  }
  const dedupeKey = `uploaded_document_ingest:${input.versionId}`;
  const id = await enqueueJob({
    jobType: UPLOADED_DOCUMENT_INGEST,
    workspaceId: input.workspaceId,
    projectId: input.scope.projectId,
    payload: { projectId: input.scope.projectId, versionId: input.versionId },
    progress: { phase: "queued", percent: 0, versionId: input.versionId },
    dedupeKey,
    createdByUserId: input.actor,
    maxAttempts: 3,
  });
  const job = id
    ? await getJob({ id, workspaceId: input.workspaceId, projectId: input.scope.projectId })
    : await findActiveJob({
      workspaceId: input.workspaceId,
      projectId: input.scope.projectId,
      jobType: UPLOADED_DOCUMENT_INGEST,
      dedupeKey,
    });
  if (!job) throw new Error("The document ingestion job could not be queued or reused.");
  return { job: sanitizeUploadedDocumentJob(job), reused: !id };
}

export async function getUploadedDocumentIngestJob(input: {
  id: string;
  workspaceId: string;
  projectId: string;
}) {
  let job = await getJob(input);
  if (job?.jobType !== UPLOADED_DOCUMENT_INGEST) return null;
  if (job.status === "pending" && pendingAgeMs(job.createdAt) >= DOCUMENT_INGEST_PENDING_CAPACITY_GRACE_MS) {
    const available = await hasHealthyWorkerCapability(UPLOADED_DOCUMENT_INGEST);
    if (!available && await failPendingJob(job.id, DOCUMENT_INGEST_UNAVAILABLE_MESSAGE)) {
      job = await getJob(input);
    }
  }
  return job?.jobType === UPLOADED_DOCUMENT_INGEST ? sanitizeUploadedDocumentJob(job) : null;
}

export async function cancelUploadedDocumentIngestJob(input: {
  id: string;
  workspaceId: string;
  projectId: string;
}) {
  const job = await requestJobCancellation(input);
  return job?.jobType === UPLOADED_DOCUMENT_INGEST ? sanitizeUploadedDocumentJob(job) : null;
}

export function sanitizeUploadedDocumentJob(job: Job) {
  const progress = job.progress ?? {};
  const result = job.result ?? null;
  return {
    id: job.id,
    status: job.status,
    versionId: typeof job.payload.versionId === "string" ? job.payload.versionId : null,
    phase: typeof progress.phase === "string" ? progress.phase : job.status,
    progress: Object.fromEntries(Object.entries(progress).filter(([key]) =>
      ["phase", "percent", "completed", "total", "versionId", "warningCount"].includes(key),
    )),
    result: result ? Object.fromEntries(Object.entries(result).filter(([key]) =>
      ["outcome", "documentId", "versionId", "chunkCount", "warningCount", "parseStatus"].includes(key),
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
