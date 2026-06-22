import "server-only";

import { createId, nowIso, sqlAll, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";

export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type Job = {
  id: string;
  workspaceId: string | null;
  jobType: string;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  runAfter: string;
  errorMessage: string | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type JobRow = {
  id: string;
  workspace_id: string | null;
  job_type: string;
  payload_json: string;
  dedupe_key: string | null;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: string | null;
  run_after: string;
  error_message: string | null;
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
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    jobType: row.job_type,
    payload,
    dedupeKey: row.dedupe_key,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    lockedAt: row.locked_at,
    runAfter: row.run_after,
    errorMessage: row.error_message,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function reapStaleJobsWithClient(client: Parameters<typeof sqlRun>[2], now: string): Promise<number> {
  const cutoff = new Date(Date.now() - staleLockMs()).toISOString();
  return sqlRun(
    `UPDATE jobs
     SET status = 'pending',
         locked_by = NULL,
         locked_at = NULL,
         run_after = @now,
         error_message = COALESCE(error_message, 'Recovered from stale worker lock.'),
         updated_at = @now
     WHERE status = 'running'
       AND locked_at IS NOT NULL
       AND locked_at < @cutoff`,
    { now, cutoff },
    client,
  );
}

export async function reapStaleJobs(): Promise<number> {
  return reapStaleJobsWithClient(undefined, nowIso());
}

export async function enqueueJob(input: {
  jobType: string;
  workspaceId?: string | null;
  payload?: Record<string, unknown>;
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
       id, workspace_id, job_type, payload_json, dedupe_key, status, priority,
       attempts, max_attempts, run_after, created_by_user_id, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @jobType, @payloadJson, @dedupeKey, 'pending', @priority,
       0, @maxAttempts, @runAfter, @createdByUserId, @now, @now
     )
     ON CONFLICT (workspace_id, job_type, dedupe_key) WHERE status IN ('pending', 'running')
     DO NOTHING
     RETURNING id`,
    {
      id,
      workspaceId: input.workspaceId ?? null,
      jobType: input.jobType,
      payloadJson: JSON.stringify(input.payload ?? {}),
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
export async function claimNextJob(workerId: string): Promise<Job | null> {
  return withTransaction(async (client) => {
    const now = nowIso();
    await reapStaleJobsWithClient(client, now);

    const row = await sqlGet<JobRow>(
      `SELECT * FROM jobs
       WHERE status = 'pending' AND run_after <= @now
       ORDER BY priority ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      { now },
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

export async function completeJob(id: string, workerId: string): Promise<boolean> {
  const now = nowIso();
  const changed = await sqlRun(
    `UPDATE jobs
     SET status = 'completed', finished_at = @now, locked_by = NULL, locked_at = NULL,
         error_message = NULL, updated_at = @now
     WHERE id = @id AND locked_by = @workerId AND status = 'running'`,
    { id, workerId, now },
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
