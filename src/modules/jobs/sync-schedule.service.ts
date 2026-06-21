import "server-only";

import { createId, nowIso, sqlAll, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import { findNextCronRun } from "@/shared/lib/cron-schedule";
import { isValidCronExpression } from "@/modules/settings/cron-expression";
import { enqueueWorkspaceContextSync } from "./workspace-sync.handler";

/**
 * Per-workspace cron sync schedule (follow-up c). One optional schedule per
 * workspace decides how often the worker enqueues that workspace's context sync.
 * The cron expression is evaluated in the worker's local timezone; next_run_at is
 * the absolute UTC ISO instant of the next fire (so `next_run_at <= now`
 * comparisons are timezone-independent). All reads/writes are keyed by a
 * server-resolved workspaceId — never client input.
 */

export type SyncScheduleView = {
  cronExpression: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastEnqueuedAt: string | null;
};

/** Invalid-schedule error with the HTTP status the route maps directly. */
export class ScheduleError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ScheduleError";
    this.status = status;
  }
}

type ScheduleRow = {
  cron_expression: string;
  enabled: number;
  next_run_at: string | null;
  last_enqueued_at: string | null;
};

function toView(row: ScheduleRow): SyncScheduleView {
  return {
    cronExpression: row.cron_expression,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    lastEnqueuedAt: row.last_enqueued_at,
  };
}

export async function getWorkspaceSyncSchedule(workspaceId: string): Promise<SyncScheduleView | null> {
  const row = await sqlGet<ScheduleRow>(
    `SELECT cron_expression, enabled, next_run_at, last_enqueued_at
     FROM workspace_sync_schedules WHERE workspace_id = @workspaceId LIMIT 1`,
    { workspaceId },
  );
  return row ? toView(row) : null;
}

export async function upsertWorkspaceSyncSchedule(input: {
  workspaceId: string;
  cronExpression: string;
  enabled: boolean;
  createdByUserId: string | null;
}): Promise<SyncScheduleView> {
  const cron = input.cronExpression.trim();
  if (!isValidCronExpression(cron)) {
    throw new ScheduleError("Enter a valid 5-field cron expression, for example 0 2 * * *.", 400);
  }
  const now = nowIso();
  // Only schedule a next run while enabled; disabling parks the schedule.
  const nextRunAt = input.enabled ? findNextCronRun(cron, new Date())?.toISOString() ?? null : null;

  await sqlRun(
    `INSERT INTO workspace_sync_schedules (
       id, workspace_id, cron_expression, enabled, next_run_at, last_enqueued_at,
       created_by_user_id, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @cron, @enabled, @nextRunAt, NULL,
       @createdByUserId, @now, @now
     )
     ON CONFLICT (workspace_id) DO UPDATE SET
       cron_expression = excluded.cron_expression,
       enabled = excluded.enabled,
       next_run_at = excluded.next_run_at,
       updated_at = excluded.updated_at`,
    {
      id: createId("sched"),
      workspaceId: input.workspaceId,
      cron,
      enabled: input.enabled ? 1 : 0,
      nextRunAt,
      createdByUserId: input.createdByUserId,
      now,
    },
  );

  return { cronExpression: cron, enabled: input.enabled, nextRunAt, lastEnqueuedAt: null };
}

export async function deleteWorkspaceSyncSchedule(workspaceId: string): Promise<void> {
  await sqlRun(`DELETE FROM workspace_sync_schedules WHERE workspace_id = @workspaceId`, { workspaceId });
}

/**
 * Worker entry point: fire every enabled schedule that is due. Claims due
 * schedules with FOR UPDATE SKIP LOCKED and advances next_run_at INSIDE the same
 * transaction so a second worker won't re-fire the same schedule; the jobs table's
 * partial-unique dedupe index prevents duplicate active sync jobs. The actual
 * enqueue happens after commit so we don't hold row locks across it. At-least-once
 * (a crash between commit and enqueue just misses one cycle). Returns the number
 * of schedules fired.
 */
export async function enqueueDueScheduledSyncs(): Promise<number> {
  const now = nowIso();
  const due = await withTransaction(async (client) => {
    const rows = await sqlAll<{ id: string; workspace_id: string; cron_expression: string }>(
      `SELECT id, workspace_id, cron_expression
       FROM workspace_sync_schedules
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= @now
       FOR UPDATE SKIP LOCKED`,
      { now },
      client,
    );
    for (const row of rows) {
      const next = findNextCronRun(row.cron_expression, new Date())?.toISOString() ?? null;
      await sqlRun(
        `UPDATE workspace_sync_schedules
         SET next_run_at = @next, last_enqueued_at = @now, updated_at = @now
         WHERE id = @id`,
        { next, now, id: row.id },
        client,
      );
    }
    return rows.map((row) => row.workspace_id);
  });

  for (const workspaceId of due) {
    try {
      const jobs = await enqueueWorkspaceContextSync(workspaceId, null);
      if (jobs) console.log(`[scheduler] enqueued ${jobs} sync job(s) for workspace ${workspaceId}`);
    } catch (error) {
      console.error(`[scheduler] failed to enqueue sync for workspace ${workspaceId}`, error);
    }
  }
  return due.length;
}
