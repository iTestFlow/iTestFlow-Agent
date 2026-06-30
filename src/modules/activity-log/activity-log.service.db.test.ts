import { afterAll, beforeAll, expect, it } from "vitest";

import { nowIso, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { getActivityLog } from "@/modules/activity-log/activity-log.service";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace } from "@/test/db";

const WS_A = "ws_actlog_a";
const WS_B = "ws_actlog_b";
const ORG_A = "https://dev.azure.com/actlog-a";
const ORG_B = "https://dev.azure.com/actlog-b";
const PROJ_A = "az_actlog_a";
const PROJ_B = "az_actlog_b";

async function insertAudit(id: string, projectId: string, azureProjectId: string, action: string) {
  // project_id is set so the scoping trigger derives workspace_id, mirroring real writes.
  await sqlRun(
    `INSERT INTO audit_logs (id, project_id, azure_project_id, action, status, message, created_at, updated_at)
     VALUES (@id, @projectId, @azureProjectId, @action, 'Success', @id, @now, @now)`,
    { id, projectId, azureProjectId, action, now: nowIso() },
  );
}

describeDb("activity log workspace scoping (DB-backed)", () => {
  beforeAll(async () => {
    await cleanupFixtures({ workspaceIds: [WS_A, WS_B], userIds: [] });
    await seedWorkspace({ id: WS_A, orgUrl: ORG_A });
    await seedWorkspace({ id: WS_B, orgUrl: ORG_B });
    await seedProject({ workspaceId: WS_A, orgUrl: ORG_A, azureProjectId: PROJ_A });
    await seedProject({ workspaceId: WS_B, orgUrl: ORG_B, azureProjectId: PROJ_B });
    await insertAudit("act_a1", PROJ_A, PROJ_A, "azure_devops.sync");
    await insertAudit("act_a2", PROJ_A, PROJ_A, "rag.index");
    await insertAudit("act_b1", PROJ_B, PROJ_B, "azure_devops.sync");
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [WS_A, WS_B], userIds: [] });
    await resetDatabaseForTests();
  });

  // R4 #4 — a workspace-scoped read returns only that workspace's rows.
  it("returns only the requesting workspace's activity", async () => {
    const result = await getActivityLog({ workspaceId: WS_A });
    expect(result.items.length).toBe(2);
    expect(result.items.every((item) => item.audit.azureProjectId === PROJ_A)).toBe(true);

    const other = await getActivityLog({ workspaceId: WS_B });
    expect(other.items.length).toBe(1);
    expect(other.items[0]?.audit.azureProjectId).toBe(PROJ_B);
  });

  // R4 #4 — a null/absent scope must NOT behave as match-all across workspaces; the
  // read stays bounded to ctx.workspace.id.
  it("does not leak other workspaces when no project scope is supplied", async () => {
    const result = await getActivityLog({ workspaceId: WS_A, scope: undefined });
    expect(result.items.length).toBe(2);
    expect(result.items.some((item) => item.audit.azureProjectId === PROJ_B)).toBe(false);
    // Available-action groups are also workspace-scoped (WS_A has azure_devops + rag).
    expect(result.availableActions.map((a) => a.value).sort()).toEqual(["azure_devops", "rag"]);
  });
});
