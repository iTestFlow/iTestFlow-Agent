import { afterAll, beforeAll, expect, it } from "vitest";

import { nowIso, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

import { deriveExecutionBoundary } from "./execution-boundary";
import { ensureRunDatabaseDiscovery } from "./run-database-discovery.service";
import {
  EnvConfigSchema,
  loadRunDatabaseDiscovery,
  loadRunForExecution,
  markRunRunning,
  recordRunDatabaseDiscovery,
} from "./run-persistence.service";

/**
 * Per-run database discovery: the recorded row IS the run's cache, it is
 * written once, and it is fenced by the owning job — a reclaimed or stale
 * worker can neither widen nor rewrite a run's database surface.
 */

const workspaceId = uniqueTestId("ws_dbdisc");
const projectId = uniqueTestId("proj_dbdisc");
const userId = uniqueTestId("usr_dbdisc");
const orgUrl = `https://dev.azure.com/${workspaceId}`;

/**
 * The frozen environment points at a deliberately unreachable database: any
 * real connection attempt fails instead of returning objects, so a cached
 * result is the only way `ensureRunDatabaseDiscovery` can report availability.
 */
const databaseEnv = EnvConfigSchema.parse({
  database: {
    driver: "postgres",
    host: "127.0.0.1",
    port: 9,
    databaseName: "unreachable",
    username: "discovery_probe",
    schemas: ["public"],
  },
});

const discoveredObjects = [
  {
    schema: "public",
    table: "orders",
    columns: [
      { name: "id", dataType: "integer" },
      { name: "status", dataType: "text" },
    ],
  },
  { schema: "billing", table: "invoices", columns: [] },
];

/** A run owned by `jobId` and in `running` status, so the job fence passes. */
async function createRunningRun(jobId: string): Promise<string> {
  // Only one run per project may be active: retire whatever an earlier case left.
  await sqlRun(
    `UPDATE test_execution_runs
     SET status = 'completed', outcome = 'passed', finished_at = @now, updated_at = @now
     WHERE project_id = @projectId AND status IN ('queued', 'running')`,
    { projectId, now: nowIso() },
  );
  const runId = uniqueTestId("run_dbdisc");
  await sqlRun(
    `INSERT INTO test_execution_runs (
       id, workspace_id, project_id, azure_project_id, env_config_json,
       approved_by, approved_at, created_by, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @projectId, @projectId, @envConfig::jsonb,
       @userId, @now, @userId, @now, @now
     )`,
    {
      id: runId,
      workspaceId,
      projectId,
      envConfig: JSON.stringify(databaseEnv),
      userId,
      now: nowIso(),
    },
  );
  expect(await markRunRunning(runId, jobId)).toBe(true);
  return runId;
}

describeDb("per-run database discovery", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedUser({ id: userId, email: `${userId}@example.com` });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
  });

  afterAll(async () => {
    // Discovery rows cascade from their run.
    await sqlRun(`DELETE FROM test_execution_runs WHERE workspace_id = @workspaceId`, {
      workspaceId,
    });
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
  });

  it("round-trips a succeeded discovery with its objects and truncation flag", async () => {
    const jobId = uniqueTestId("job_dbdisc");
    const runId = await createRunningRun(jobId);

    expect(await recordRunDatabaseDiscovery({
      runId,
      jobId,
      workspaceId,
      projectId,
      azureProjectId: projectId,
      driver: "postgres",
      status: "succeeded",
      truncated: true,
      objects: discoveredObjects,
    })).toBe(true);

    expect(await loadRunDatabaseDiscovery(runId)).toEqual({
      status: "succeeded",
      driver: "postgres",
      truncated: true,
      errorCode: null,
      errorMessage: null,
      objects: discoveredObjects,
    });
  });

  it("records the run's surface once: a later discovery never overwrites it", async () => {
    const jobId = uniqueTestId("job_dbdisc");
    const runId = await createRunningRun(jobId);
    const record = {
      runId,
      jobId,
      workspaceId,
      projectId,
      azureProjectId: projectId,
      driver: "postgres" as const,
      status: "succeeded" as const,
    };

    expect(await recordRunDatabaseDiscovery({
      ...record,
      truncated: true,
      objects: discoveredObjects,
    })).toBe(true);
    // A second discovery — e.g. after the account's grants widened mid-run.
    expect(await recordRunDatabaseDiscovery({
      ...record,
      truncated: false,
      objects: [{ schema: "public", table: "payroll", columns: [] }],
    })).toBe(false);

    const loaded = await loadRunDatabaseDiscovery(runId);
    expect(loaded?.objects).toEqual(discoveredObjects);
    expect(loaded?.truncated).toBe(true);
  });

  it("refuses to record for a run this job no longer owns", async () => {
    const jobId = uniqueTestId("job_dbdisc");
    const runId = await createRunningRun(jobId);

    expect(await recordRunDatabaseDiscovery({
      runId,
      jobId: `${jobId}_stale`,
      workspaceId,
      projectId,
      azureProjectId: projectId,
      driver: "postgres",
      status: "succeeded",
      truncated: false,
      objects: discoveredObjects,
    })).toBe(false);

    expect(await loadRunDatabaseDiscovery(runId)).toBeNull();
  });

  it("round-trips a failed discovery with its classified failure detail", async () => {
    const jobId = uniqueTestId("job_dbdisc");
    const runId = await createRunningRun(jobId);

    expect(await recordRunDatabaseDiscovery({
      runId,
      jobId,
      workspaceId,
      projectId,
      azureProjectId: projectId,
      driver: "postgres",
      status: "failed",
      truncated: false,
      errorCode: "authentication",
      errorMessage: "permission denied for schema public",
      objects: [],
    })).toBe(true);

    expect(await loadRunDatabaseDiscovery(runId)).toEqual({
      status: "failed",
      driver: "postgres",
      truncated: false,
      errorCode: "authentication",
      errorMessage: "permission denied for schema public",
      objects: [],
    });
  });

  it("reuses the recorded discovery instead of connecting again", async () => {
    const jobId = uniqueTestId("job_dbdisc");
    const runId = await createRunningRun(jobId);
    await recordRunDatabaseDiscovery({
      runId,
      jobId,
      workspaceId,
      projectId,
      azureProjectId: projectId,
      driver: "postgres",
      status: "succeeded",
      truncated: true,
      objects: discoveredObjects,
    });

    const bundle = await loadRunForExecution(runId);
    expect(bundle?.run.jobId).toBe(jobId);
    // With a password present, a cache miss WOULD dial the frozen host — and
    // that host is unreachable, so reporting the recorded objects can only
    // come from the recorded row.
    bundle!.connectionSecrets.set("db.password", "never-used");

    expect(await ensureRunDatabaseDiscovery({
      bundle: bundle!,
      env: databaseEnv,
      boundary: deriveExecutionBoundary(databaseEnv),
      signal: new AbortController().signal,
    })).toEqual({ available: true, objects: discoveredObjects, truncated: true });
  });
});
