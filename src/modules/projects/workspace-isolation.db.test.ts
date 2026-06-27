import { afterAll, beforeAll, expect, it } from "vitest";

import { nowIso, resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { resolveProjectScope, upsertWorkspaceProject } from "@/modules/projects/workspace-projects.service";
import type { WorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { cleanupFixtures, describeDb, seedWorkspace } from "@/test/db";

const WS = "ws_scoping_trigger";
const ORG = "https://dev.azure.com/scoping-trigger";
const ctx: WorkflowContext = {
  userId: "user_scoping_trigger",
  workspace: { id: WS, name: "Scoping", azureOrgName: "scoping-trigger", azureOrgUrl: ORG },
};

describeDb("workspace_id scoping trigger & id reconciliation (DB-backed)", () => {
  // These rows can have NULL workspace_id/azure_project_id (the whole point of the
  // negative trigger case), so they aren't covered by cleanupFixtures — delete by id.
  async function cleanupLocalRows() {
    await sqlRun(`DELETE FROM analytics_workflow_runs WHERE id = 'run_collision'`, {});
    await sqlRun(`DELETE FROM audit_logs WHERE id IN ('audit_trigger_pos', 'audit_trigger_neg')`, {});
  }

  beforeAll(async () => {
    await cleanupLocalRows();
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await seedWorkspace({ id: WS, orgUrl: ORG });
  });

  afterAll(async () => {
    await cleanupLocalRows();
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  // R4 #2 (positive) — the set_workspace_id_from_project trigger derives workspace_id
  // from a known project_id when the insert omits it.
  it("trigger derives workspace_id from a known project_id", async () => {
    await upsertWorkspaceProject(ctx, { azureProjectId: "az_trigger_pos", azureProjectName: "Trigger Pos" });

    const id = "audit_trigger_pos";
    await sqlRun(
      `INSERT INTO audit_logs (id, project_id, action, status, message, created_at, updated_at)
       VALUES (@id, @projectId, 'test.trigger', 'Info', 'pos', @now, @now)`,
      { id, projectId: "az_trigger_pos", now: nowIso() },
    );
    const row = await sqlGet<{ workspace_id: string | null }>(`SELECT workspace_id FROM audit_logs WHERE id = @id`, { id });
    expect(row?.workspace_id).toBe(WS);
  });

  // R4 #2 (negative) — the trigger FAILS OPEN to NULL when the project_id is unknown,
  // which is exactly why server code must set workspace_id explicitly (INV-3) rather
  // than rely on the trigger.
  it("trigger leaves workspace_id NULL for an unknown project_id (fails open)", async () => {
    const id = "audit_trigger_neg";
    await sqlRun(
      `INSERT INTO audit_logs (id, project_id, action, status, message, created_at, updated_at)
       VALUES (@id, @projectId, 'test.trigger', 'Info', 'neg', @now, @now)`,
      { id, projectId: "project_that_does_not_exist", now: nowIso() },
    );
    const row = await sqlGet<{ workspace_id: string | null }>(`SELECT workspace_id FROM audit_logs WHERE id = @id`, { id });
    expect(row?.workspace_id).toBeNull();
  });

  // R4 #7 — the interactive anchor and the worker/scheduled path converge on
  // project_id = the Azure GUID (INV-1 / R1.6), so writes from either path collide on
  // one key instead of forking the data by an internal token id.
  it("interactive and worker paths key feature rows on the same project_id (= Azure GUID)", async () => {
    const guid = "az_collision_project";
    const scope = await upsertWorkspaceProject(ctx, { azureProjectId: guid, azureProjectName: "Collision" });
    expect(scope.projectId).toBe(guid);
    expect(scope.azureProjectId).toBe(guid);

    // The worker selects projects by workspace and keys writes on projects.id; assert
    // that id equals the GUID the interactive resolver also uses.
    const workerSeenId = await sqlGet<{ id: string; azure_project_id: string }>(
      `SELECT id, azure_project_id FROM projects WHERE workspace_id = @ws AND azure_project_id = @guid`,
      { ws: WS, guid },
    );
    expect(workerSeenId?.id).toBe(guid);
    expect(workerSeenId?.id).toBe(workerSeenId?.azure_project_id);

    // A feature row written under the interactive scope is found by the worker's key.
    await sqlRun(
      `INSERT INTO analytics_workflow_runs (id, project_id, azure_project_id, user_id, workflow_type, started_at, status, created_at, updated_at)
       VALUES (@id, @projectId, @azureProjectId, @user, 'test_case_design', @now, 'started', @now, @now)`,
      { id: "run_collision", projectId: scope.projectId, azureProjectId: scope.azureProjectId, user: ctx.userId, now: nowIso() },
    );
    const found = await sqlGet<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM analytics_workflow_runs WHERE project_id = @workerId`,
      { workerId: workerSeenId!.id },
    );
    expect(found?.count).toBe(1);

    // And resolveProjectScope returns the same canonical projectId for a client hint.
    const resolved = await resolveProjectScope(ctx, {
      projectId: guid,
      azureProjectId: guid,
      azureProjectName: "Collision",
      azureOrganizationUrl: ORG,
      workspaceId: WS,
    });
    expect(resolved.projectId).toBe(guid);
  });
});
