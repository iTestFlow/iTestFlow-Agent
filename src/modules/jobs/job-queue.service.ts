import "server-only";

import { createId, nowIso, sqlAll, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type Job = {
  id: string;
  workspaceId: string | null;
  projectId?: string | null;
  jobType: string;
  payload: Record<string, unknown>;
  progress?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  dedupeKey: string | null;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  runAfter: string;
  errorMessage: string | null;
  cancelRequestedAt?: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type JobRow = {
  id: string;
  workspace_id: string | null;
  project_id: string | null;
  job_type: string;
  payload_json: string;
  progress_json: unknown;
  result_json: unknown;
  dedupe_key: string | null;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: string | null;
  run_after: string;
  error_message: string | null;
  cancel_requested_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;

function staleLockMs() {
  const value = Number(process.env.JOB_STALE_LOCK_MS ?? String(DEFAULT_STALE_LOCK_MS));
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_STALE_LOCK_MS;
}

function mapJob(row: JobRow): Job {
  const payload = parseRecord(row.payload_json);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    jobType: row.job_type,
    payload,
    progress: parseRecord(row.progress_json),
    result: row.result_json === null ? null : parseRecord(row.result_json),
    dedupeKey: row.dedupe_key,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    runAfter: row.run_after,
    errorMessage: row.error_message,
    cancelRequestedAt: row.cancel_requested_at,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Reclaim jobs whose worker died without releasing the lock. Two atomic branches,
 * each a single race-safe statement (no select-then-update):
 *
 *  - stale AND retries remaining  -> back to 'pending' for another worker.
 *  - stale AND retries exhausted  -> 'failed', so a poison-pill job (one that keeps
 *    killing its worker mid-run) cannot loop forever being requeued.
 *
 * `attempts` is incremented at claim and is NOT decremented here: the worker
 * heartbeat (heartbeatJob) keeps a healthy long-running job's lock fresh, so a job
 * only goes stale when its worker is genuinely lost — which legitimately consumes
 * one attempt and also bounds poison-pill retries. `running -> pending` keeps the
 * uq_jobs_active_dedupe slot; `running -> failed` frees it (both intended).
 */
function normalizeSupportedJobTypes(supportedJobTypes?: readonly string[]): string[] | undefined {
  if (supportedJobTypes === undefined) return undefined;
  return Array.from(new Set(supportedJobTypes.map((jobType) => jobType.trim()).filter(Boolean)));
}

async function reapStaleJobsWithClient(
  client: Parameters<typeof sqlRun>[2],
  now: string,
  supportedJobTypes?: readonly string[],
): Promise<number> {
  const cutoff = new Date(Date.now() - staleLockMs()).toISOString();
  const jobTypeClause = supportedJobTypes
    ? "\n       AND job_type = ANY(@supportedJobTypes)"
    : "";
  const params = {
    now,
    cutoff,
    ...(supportedJobTypes ? { supportedJobTypes: [...supportedJobTypes] } : {}),
  };
  const requeued = await sqlRun(
    `UPDATE jobs
     SET status = 'pending',
         locked_by = NULL,
         locked_at = NULL,
         run_after = @now,
         error_message = COALESCE(error_message, 'Recovered from stale worker lock.'),
         updated_at = @now
     WHERE status = 'running'
       AND locked_at IS NOT NULL
       AND locked_at < @cutoff
       AND attempts < max_attempts${jobTypeClause}`,
    params,
    client,
  );
  const failed = await sqlRun(
    `UPDATE jobs
     SET status = 'failed',
         finished_at = @now,
         locked_by = NULL,
         locked_at = NULL,
         error_message = COALESCE(NULLIF(error_message, ''), 'Stale worker lock reclaimed; retries exhausted.'),
         updated_at = @now
     WHERE status = 'running'
       AND locked_at IS NOT NULL
       AND locked_at < @cutoff
       AND attempts >= max_attempts${jobTypeClause}`,
    params,
    client,
  );
  return requeued + failed;
}

export async function reapStaleJobs(): Promise<number> {
  return reapStaleJobsWithClient(undefined, nowIso());
}

export async function enqueueJob(input: {
  jobType: string;
  workspaceId?: string | null;
  projectId?: string | null;
  payload?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  dedupeKey?: string | null;
  priority?: number;
  maxAttempts?: number;
  runAfter?: string;
  createdByUserId?: string | null;
}): Promise<string | null> {
  const id = createId("job");
  const now = nowIso();
  // ON CONFLICT on the partial unique index (workspace, type, dedupe_key for
  // active jobs) makes enqueue idempotent — a duplicate active job is skipped.
  const inserted = await sqlGet<{ id: string }>(
    `INSERT INTO jobs (
       id, workspace_id, project_id, job_type, payload_json, progress_json, dedupe_key, status, priority,
       attempts, max_attempts, run_after, created_by_user_id, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @projectId, @jobType, @payloadJson, @progressJson::jsonb, @dedupeKey, 'pending', @priority,
       0, @maxAttempts, @runAfter, @createdByUserId, @now, @now
     )
     ON CONFLICT (workspace_id, job_type, dedupe_key) WHERE status IN ('pending', 'running')
     DO NOTHING
     RETURNING id`,
    {
      id,
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      jobType: input.jobType,
      payloadJson: JSON.stringify(input.payload ?? {}),
      progressJson: JSON.stringify(input.progress ?? { phase: "queued", percent: 0 }),
      dedupeKey: input.dedupeKey ?? null,
      priority: input.priority ?? 100,
      maxAttempts: input.maxAttempts ?? 3,
      runAfter: input.runAfter ?? now,
      createdByUserId: input.createdByUserId ?? null,
      now,
    },
  );
  return inserted?.id ?? null;
}

/**
 * Atomically claim the next ready job. FOR UPDATE SKIP LOCKED means concurrent
 * workers never select the same row. Marks it running, bumps attempts, and
 * stamps the worker id — all in one transaction.
 */
export async function claimNextJob(
  workerId: string,
  supportedJobTypes?: readonly string[],
): Promise<Job | null> {
  const normalizedJobTypes = normalizeSupportedJobTypes(supportedJobTypes);
  if (normalizedJobTypes?.length === 0) return null;

  return withTransaction(async (client) => {
    const now = nowIso();
    await reapStaleJobsWithClient(client, now, normalizedJobTypes);
    const jobTypeClause = normalizedJobTypes
      ? " AND job_type = ANY(@supportedJobTypes)"
      : "";

    const row = await sqlGet<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'pending' AND run_after <= @now${jobTypeClause}
       ORDER BY priority ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      {
        now,
        ...(normalizedJobTypes ? { supportedJobTypes: normalizedJobTypes } : {}),
      },
      client,
    );
    if (!row) return null;

    await sqlRun(
      `UPDATE jobs
       SET status = 'running', locked_by = @workerId, locked_at = @now,
           started_at = COALESCE(started_at, @now), attempts = attempts + 1, updated_at = @now
       WHERE id = @id`,
      { workerId, now, id: row.id },
      client,
    );
    return mapJob({ ...row, status: "running", attempts: row.attempts + 1, locked_by: workerId, locked_at: now });
  });
}

export async function heartbeatJob(id: string, workerId: string): Promise<boolean> {
  const now = nowIso();
  const changed = await sqlRun(
    `UPDATE jobs
     SET locked_at = @now, updated_at = @now
     WHERE id = @id AND locked_by = @workerId AND status = 'running'`,
    { id, workerId, now },
  );
  return changed > 0;
}

export async function completeJob(
  id: string,
  workerId: string,
  result?: Record<string, unknown> | null,
): Promise<boolean> {
  const now = nowIso();
  const changed = await sqlRun(
    `UPDATE jobs
     SET status = 'completed', finished_at = @now, locked_by = NULL, locked_at = NULL,
         error_message = NULL, result_json = @resultJson::jsonb,
         progress_json = progress_json || '{"phase":"completed","percent":100}'::jsonb,
         updated_at = @now
     WHERE id = @id AND locked_by = @workerId AND status = 'running'`,
    { id, workerId, now, resultJson: JSON.stringify(result ?? {}) },
  );
  return changed > 0;
}

/**
 * Fail a job. Retries with exponential backoff until max_attempts is reached,
 * then marks it permanently failed. (attempts was already incremented at claim.)
 */
export async function failJob(id: string, errorMessage: string, workerId: string): Promise<boolean> {
  const row = await sqlGet<{ attempts: number; max_attempts: number }>(
    `SELECT attempts, max_attempts
     FROM jobs
     WHERE id = @id AND locked_by = @workerId AND status = 'running'`,
    { id, workerId },
  );
  if (!row) return false;
  const now = nowIso();
  const message = errorMessage.slice(0, 2000);

  if (row.attempts >= row.max_attempts) {
    const changed = await sqlRun(
      `UPDATE jobs
       SET status = 'failed', finished_at = @now, error_message = @message,
           locked_by = NULL, locked_at = NULL, updated_at = @now
       WHERE id = @id AND locked_by = @workerId AND status = 'running'`,
      { id, workerId, now, message },
    );
    return changed > 0;
  }

  const backoffMs = Math.min(2 ** row.attempts * 1000, MAX_BACKOFF_MS);
  const runAfter = new Date(Date.now() + backoffMs).toISOString();
  const changed = await sqlRun(
    `UPDATE jobs SET status = 'pending', run_after = @runAfter, error_message = @message,
       locked_by = NULL, locked_at = NULL, updated_at = @now
     WHERE id = @id AND locked_by = @workerId AND status = 'running'`,
    { id, workerId, runAfter, message, now },
  );
  return changed > 0;
}

export async function listJobs(workspaceId: string, limit = 50): Promise<Job[]> {
  const rows = await sqlAll<JobRow>(
    `SELECT * FROM jobs WHERE workspace_id = @workspaceId ORDER BY created_at DESC LIMIT @limit`,
    { workspaceId, limit: Math.min(200, Math.max(1, limit)) },
  );
  return rows.map(mapJob);
}

export async function failPendingJob(id: string, errorMessage: string): Promise<boolean> {
  const now = nowIso();
  return (await sqlRun(
    `UPDATE jobs
     SET status = 'failed', finished_at = @now, error_message = @message,
         locked_by = NULL, locked_at = NULL, updated_at = @now
     WHERE id = @id AND status = 'pending'`,
    { id, now, message: errorMessage.slice(0, 2000) },
  )) > 0;
}

export async function getJob(input: {
  id: string;
  workspaceId?: string;
  projectId?: string;
}) {
  const row = await sqlGet<JobRow>(
    `SELECT * FROM jobs
     WHERE id = @id
       AND (@workspaceId::text IS NULL OR workspace_id = @workspaceId)
       AND (@projectId::text IS NULL OR project_id = @projectId)
     LIMIT 1`,
    {
      id: input.id,
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
    },
  );
  return row ? mapJob(row) : null;
}

export async function findActiveJob(input: {
  workspaceId: string;
  projectId: string;
  jobType: string;
  dedupeKey: string;
}) {
  const row = await sqlGet<JobRow>(
    `SELECT * FROM jobs
     WHERE workspace_id = @workspaceId AND project_id = @projectId
       AND job_type = @jobType AND dedupe_key = @dedupeKey
       AND status IN ('pending', 'running')
     ORDER BY created_at ASC
     LIMIT 1`,
    input,
  );
  return row ? mapJob(row) : null;
}

export async function updateJobProgress(
  id: string,
  workerId: string,
  progress: Record<string, unknown>,
) {
  const now = nowIso();
  return (await sqlRun(
    `UPDATE jobs
     SET progress_json = @progressJson::jsonb, updated_at = @now, locked_at = @now
     WHERE id = @id AND locked_by = @workerId AND status = 'running'`,
    { id, workerId, progressJson: JSON.stringify(progress), now },
  )) > 0;
}

export async function requestJobCancellation(input: {
  id: string;
  workspaceId: string;
  projectId: string;
}) {
  return withTransaction(async (client) => {
    const row = await sqlGet<JobRow>(
      `SELECT * FROM jobs
       WHERE id = @id AND workspace_id = @workspaceId AND project_id = @projectId
       FOR UPDATE`,
      input,
      client,
    );
    if (!row) return null;
    const now = nowIso();
    if (row.status === "pending") {
      await sqlRun(
        `UPDATE jobs SET status = 'cancelled', cancel_requested_at = @now,
           finished_at = @now, updated_at = @now
         WHERE id = @id`,
        { id: input.id, now },
        client,
      );
    } else if (row.status === "running" && !row.cancel_requested_at) {
      await sqlRun(
        `UPDATE jobs SET cancel_requested_at = @now, updated_at = @now WHERE id = @id`,
        { id: input.id, now },
        client,
      );
    }
    const updated = await sqlGet<JobRow>(`SELECT * FROM jobs WHERE id = @id`, { id: input.id }, client);
    return updated ? mapJob(updated) : null;
  });
}

export async function isJobCancellationRequested(id: string, workerId: string) {
  const row = await sqlGet<{ cancel_requested_at: string | null }>(
    `SELECT cancel_requested_at FROM jobs
     WHERE id = @id AND locked_by = @workerId AND status = 'running'`,
    { id, workerId },
  );
  return Boolean(row?.cancel_requested_at);
}

export async function cancelRunningJob(id: string, workerId: string) {
  const now = nowIso();
  return (await sqlRun(
    `UPDATE jobs SET status = 'cancelled', finished_at = @now,
       locked_by = NULL, locked_at = NULL, updated_at = @now
     WHERE id = @id AND locked_by = @workerId AND status = 'running'`,
    { id, workerId, now },
  )) > 0;
}

export async function loadCompletedJobBatch(jobId: string, batchKey: string) {
  const row = await sqlGet<{ result_json: unknown }>(
    `SELECT result_json FROM project_knowledge_job_batches
     WHERE job_id = @jobId AND batch_key = @batchKey AND status = 'completed'`,
    { jobId, batchKey },
  );
  return row ? parseRecord(row.result_json) : null;
}

export async function completeJobBatch(input: {
  jobId: string;
  batchKey: string;
  result: Record<string, unknown>;
}) {
  const now = nowIso();
  await sqlRun(
    `INSERT INTO project_knowledge_job_batches (
       id, job_id, batch_key, status, result_json, created_at, updated_at
     ) VALUES (@id, @jobId, @batchKey, 'completed', @resultJson::jsonb, @now, @now)
     ON CONFLICT (job_id, batch_key) DO UPDATE SET
       status = 'completed', result_json = EXCLUDED.result_json, updated_at = EXCLUDED.updated_at`,
    {
      id: createId("pkjb"),
      jobId: input.jobId,
      batchKey: input.batchKey,
      resultJson: JSON.stringify(input.result),
      now,
    },
  );
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
