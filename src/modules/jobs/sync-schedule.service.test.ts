import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createId, nowIso, resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import { getWorkspaceById } from "@/modules/workspace/workspace.service";
import {
  deleteWorkspaceSyncSchedule,
  enqueueDueScheduledSyncs,
  getWorkspaceSyncSchedule,
  ScheduleError,
  upsertWorkspaceSyncSchedule,
} from "@/modules/jobs/sync-schedule.service";

const TEST_EMAIL = "owner-sched@itestflow.test";
const TEST_ORG = "itestflow-sched-test-org";
const TEST_ORG_URL = "https://dev.azure.com/itestflow-sched-test-org";

// DB-backed (ADR-9): requires migrated PostgreSQL via DATABASE_URL; skipped otherwise.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

async function cleanup(workspaceId?: string) {
  if (workspaceId) await sqlRun(`DELETE FROM jobs WHERE workspace_id = @id`, { id: workspaceId });
  await sqlRun(`DELETE FROM projects WHERE azure_organization_url = @url`, { url: TEST_ORG_URL });
  await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
  await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email: TEST_EMAIL });
}

describeDb("workspace sync schedule (DB-backed)", () => {
  let workspaceId: string;

  beforeAll(async () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = TEST_EMAIL;
    process.env.BOOTSTRAP_OWNER_AZURE_ORG = TEST_ORG;
    await cleanup();
    const bootstrap = await ensureBootstrapOwner();
    workspaceId = bootstrap!.workspaceId;
  });

  afterAll(async () => {
    await cleanup(workspaceId);
    await resetDatabaseForTests();
  });

  it("returns null before a schedule is set", async () => {
    expect(await getWorkspaceSyncSchedule(workspaceId)).toBeNull();
  });

  it("rejects an invalid cron expression", async () => {
    await expect(
      upsertWorkspaceSyncSchedule({ workspaceId, cronExpression: "not a cron", enabled: true, createdByUserId: null }),
    ).rejects.toMatchObject({ status: 400 });
    expect(ScheduleError).toBeDefined();
  });

  it("stores a schedule and computes a future next_run_at when enabled", async () => {
    const view = await upsertWorkspaceSyncSchedule({
      workspaceId,
      cronExpression: "0 2 * * *",
      enabled: true,
      workItemTypes: ["User Story", "Requirement"],
      states: ["Active", "Ready"],
      createdByUserId: null,
    });
    expect(view.enabled).toBe(true);
    expect(view.nextRunAt).not.toBeNull();
    expect(Date.parse(view.nextRunAt!)).toBeGreaterThan(Date.now());
    expect(view.workItemTypes).toEqual(["User Story", "Requirement"]);
    expect(view.states).toEqual(["Active", "Ready"]);
  });

  it("parks the schedule (null next_run_at, excluded from due) when disabled", async () => {
    const view = await upsertWorkspaceSyncSchedule({
      workspaceId,
      cronExpression: "0 2 * * *",
      enabled: false,
      workItemTypes: ["Bug"],
      states: ["New"],
      createdByUserId: null,
    });
    expect(view.enabled).toBe(false);
    expect(view.nextRunAt).toBeNull();
    // A disabled schedule is never fired.
    expect(await enqueueDueScheduledSyncs()).toBe(0);
  });

  it("fires a due schedule, enqueues a sync job, advances next_run_at, and is idempotent", async () => {
    // Re-enable and seed an active project so enqueueWorkspaceContextSync produces a job.
    await upsertWorkspaceSyncSchedule({
      workspaceId,
      cronExpression: "0 2 * * *",
      enabled: true,
      workItemTypes: ["User Story"],
      states: ["Active"],
      createdByUserId: null,
    });
    const workspace = await getWorkspaceById(workspaceId);
    const now = nowIso();
    await sqlRun(
      `INSERT INTO projects (id, azure_project_id, azure_project_name, azure_organization_url, name, status, created_at, updated_at)
       VALUES (@id, 'apid-1', 'Proj One', @url, 'Proj One', 'active', @now, @now)`,
      { id: createId("proj"), url: workspace!.azureOrgUrl, now },
    );

    // Force it due (upsert always computes a future next_run_at).
    const past = new Date(Date.now() - 60_000).toISOString();
    await sqlRun(`UPDATE workspace_sync_schedules SET next_run_at = @past WHERE workspace_id = @id`, { past, id: workspaceId });

    const fired = await enqueueDueScheduledSyncs();
    expect(fired).toBe(1);

    const after = await getWorkspaceSyncSchedule(workspaceId);
    expect(after?.lastEnqueuedAt).not.toBeNull();
    expect(Date.parse(after!.nextRunAt!)).toBeGreaterThan(Date.now());

    const job = await sqlGet<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM jobs WHERE workspace_id = @id AND job_type = 'workspace_context_sync'`,
      { id: workspaceId },
    );
    expect(job?.count).toBe(1);
    const payloadRow = await sqlGet<{ payload_json: string }>(
      `SELECT payload_json FROM jobs WHERE workspace_id = @id AND job_type = 'workspace_context_sync' LIMIT 1`,
      { id: workspaceId },
    );
    expect(JSON.parse(payloadRow!.payload_json)).toMatchObject({
      workItemTypes: ["User Story"],
      states: ["Active"],
    });

    // Already advanced into the future ⇒ a second tick fires nothing.
    expect(await enqueueDueScheduledSyncs()).toBe(0);
  });

  it("removes the schedule", async () => {
    await deleteWorkspaceSyncSchedule(workspaceId);
    expect(await getWorkspaceSyncSchedule(workspaceId)).toBeNull();
  });
});
