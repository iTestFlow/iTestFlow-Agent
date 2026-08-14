import { afterAll, beforeAll, expect, it } from "vitest";

import { resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedProject, seedUser, seedWorkspace, uniqueTestId } from "@/test/db";
import {
  beginFailedExecutionPublicationRetry,
  finishExecutionPublication,
  recordExecutionPublicationResult,
} from "./execution-store.service";

const workspaceId = uniqueTestId("ws_pw_publication");
const userId = uniqueTestId("user_pw_publication");
const projectId = uniqueTestId("project_pw_publication");
const orgUrl = "https://dev.azure.com/pw-publication";

async function seedPublication(input: { status?: "running" | "failed"; updatedAt?: string; result?: unknown }) {
  const runId = uniqueTestId("pwrun");
  const publicationId = uniqueTestId("pwpub");
  const now = new Date().toISOString();
  await sqlRun(
    `INSERT INTO playwright_execution_runs (
       id, workspace_id, project_id, azure_plan_id, azure_suite_id, status,
       requested_by_user_id, created_at, updated_at
     ) VALUES (@runId, @workspaceId, @projectId, 1, 2, 'passed', @userId, @now, @now)`,
    { runId, workspaceId, projectId, userId, now },
  );
  await sqlRun(
    `INSERT INTO playwright_execution_publications (
       id, run_id, published_by_user_id, status, result_json, lease_token, created_at, updated_at
     ) VALUES (@publicationId, @runId, @userId, @status, @result::jsonb, 'current-lease', @now, @updatedAt)`,
    {
      publicationId, runId, userId, status: input.status ?? "running",
      result: JSON.stringify(input.result ?? []), now, updatedAt: input.updatedAt ?? now,
    },
  );
  return { runId, publicationId };
}

describeDb("Playwright execution publication leases (DB-backed)", () => {
  beforeAll(async () => {
    await seedUser({ id: userId, email: `${userId}@example.test` });
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
    await resetDatabaseForTests();
  });

  it("fences receipt append and finalization to the current publication lease", async () => {
    const { publicationId } = await seedPublication({});
    const receipt = { testCaseId: 4, testPointId: 5, success: true };
    await expect(recordExecutionPublicationResult(publicationId, "stale-lease", receipt)).resolves.toBe(false);
    await expect(recordExecutionPublicationResult(publicationId, "current-lease", receipt)).resolves.toBe(true);
    await finishExecutionPublication({ id: publicationId, leaseToken: "stale-lease", status: "completed", result: [receipt] });
    let row = await sqlGet<{ status: string; result_json: unknown }>(
      `SELECT status, result_json FROM playwright_execution_publications WHERE id = @publicationId`, { publicationId },
    );
    expect(row).toEqual({ status: "running", result_json: [receipt] });
    await finishExecutionPublication({ id: publicationId, leaseToken: "current-lease", status: "completed", result: [receipt] });
    row = await sqlGet<{ status: string; result_json: unknown }>(
      `SELECT status, result_json FROM playwright_execution_publications WHERE id = @publicationId`, { publicationId },
    );
    expect(row).toEqual({ status: "completed", result_json: [receipt] });
  });

  it("refreshes a reclaimed lease so it cannot be reclaimed again immediately", async () => {
    const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const { runId, publicationId } = await seedPublication({ updatedAt: staleAt, result: [{ testCaseId: 4, testPointId: 5, success: true }] });
    const reclaimed = await beginFailedExecutionPublicationRetry(runId);
    expect(reclaimed).toMatchObject({ id: publicationId, prior: [{ testCaseId: 4, testPointId: 5, success: true }] });
    const row = await sqlGet<{ lease_token: string; updated_at: string }>(
      `SELECT lease_token, updated_at FROM playwright_execution_publications WHERE id = @publicationId`, { publicationId },
    );
    expect(row?.lease_token).toBe(reclaimed?.leaseToken);
    expect(new Date(row!.updated_at).getTime()).toBeGreaterThan(new Date(staleAt).getTime());
    await expect(beginFailedExecutionPublicationRetry(runId)).resolves.toBeNull();
  });
});
