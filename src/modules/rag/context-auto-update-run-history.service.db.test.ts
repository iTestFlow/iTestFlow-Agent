import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import {
  completeContextAutoUpdateRun,
  getLatestContextAutoUpdateRun,
  startContextAutoUpdateRun,
} from "@/modules/rag/context-auto-update-run-history.service";
import {
  resetDatabaseForTests,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

const workspaceId = uniqueTestId("ws_cau");
const projectId = uniqueTestId("project_cau");
const organizationUrl = `https://dev.azure.com/${uniqueTestId("org")}`;
const scope = {
  projectId,
  azureProjectId: projectId,
  azureProjectName: "Context history project",
  azureOrganizationUrl: organizationUrl,
};
const runIds: string[] = [];

describeDb("context auto-update run history (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl: organizationUrl });
    await seedProject({
      workspaceId,
      orgUrl: organizationUrl,
      azureProjectId: projectId,
      azureProjectName: scope.azureProjectName,
    });
  });

  afterEach(async () => {
    if (runIds.length) {
      await sqlRun(
        `DELETE FROM context_auto_update_runs WHERE id = ANY(@ids)`,
        { ids: runIds.splice(0) },
      );
    }
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [] });
    await resetDatabaseForTests();
  });

  it("starts a running record with zeroed counters and the requested filters", async () => {
    const id = await startContextAutoUpdateRun({
      scope,
      cronExpression: "0 */2 * * *",
      cronTimezone: "Africa/Cairo",
      workItemTypes: ["User Story", "Bug"],
      states: ["Active"],
      contextSyncMode: "incremental",
      knowledgeCompileMode: "changed-only",
    });
    runIds.push(id);

    const run = await getLatestContextAutoUpdateRun();

    expect(run).toMatchObject({
      id,
      projectId,
      status: "Running",
      cronExpression: "0 */2 * * *",
      cronTimezone: "Africa/Cairo",
      workItemTypes: ["User Story", "Bug"],
      states: ["Active"],
      contextFetchedCount: 0,
      contextIndexedChunkCount: 0,
      knowledgeCompileStatus: "pending",
    });
    expect(run?.completedAt).toBeNull();
  });

  it("persists terminal counters, completion time, and failure recovery details", async () => {
    const id = await startContextAutoUpdateRun({
      scope,
      cronExpression: "0 1 * * *",
      cronTimezone: "UTC",
      workItemTypes: ["User Story"],
      states: ["Active"],
      contextSyncMode: "full",
      knowledgeCompileMode: "full",
    });
    runIds.push(id);

    await completeContextAutoUpdateRun({
      id,
      status: "Partial failure",
      cronTimezone: "UTC",
      contextSyncMode: "full",
      contextFetchedCount: 12,
      contextIndexedWorkItemCount: 10,
      contextIndexedChunkCount: 24,
      contextCreatedCount: 7,
      contextUpdatedCount: 3,
      contextSkippedEmptyCount: 2,
      knowledgeSourceWorkItemCount: 9,
      knowledgeCompileMode: "full",
      knowledgeCompileStatus: "failed",
      errorDetails: "One batch timed out.",
    });

    const run = await getLatestContextAutoUpdateRun();

    expect(run).toMatchObject({
      id,
      status: "Partial failure",
      contextFetchedCount: 12,
      contextIndexedWorkItemCount: 10,
      contextIndexedChunkCount: 24,
      contextCreatedCount: 7,
      contextUpdatedCount: 3,
      contextSkippedEmptyCount: 2,
      knowledgeSourceWorkItemCount: 9,
      knowledgeCompileStatus: "failed",
      errorDetails: "One batch timed out.",
    });
    expect(run?.completedAt).toBeTruthy();
  });

  it("returns the globally latest run rather than an older project run", async () => {
    const oldId = await startContextAutoUpdateRun({
      scope,
      cronExpression: "0 0 * * *",
      cronTimezone: "UTC",
      workItemTypes: [],
      states: [],
      contextSyncMode: "full",
      knowledgeCompileMode: "full",
    });
    runIds.push(oldId);
    await new Promise((resolve) => setTimeout(resolve, 2));
    const latestId = await startContextAutoUpdateRun({
      scope,
      cronExpression: "0 3 * * *",
      cronTimezone: "UTC",
      workItemTypes: ["Bug"],
      states: ["New"],
      contextSyncMode: "incremental",
      knowledgeCompileMode: "changed-only",
    });
    runIds.push(latestId);

    expect((await getLatestContextAutoUpdateRun())?.id).toBe(latestId);
    expect(await sqlGet<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM context_auto_update_runs WHERE id = ANY(@ids)`,
      { ids: [oldId, latestId] },
    )).toEqual({ count: 2 });
  });
});
