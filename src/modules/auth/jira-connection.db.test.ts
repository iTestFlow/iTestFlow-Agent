import { afterAll, beforeAll, expect, it } from "vitest";

import {
  getPool,
  nowIso,
  resetDatabaseForTests,
  sqlAll,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedMembership, seedUser, uniqueTestId } from "@/test/db";
import { storeJiraConnection } from "./jira-connection.service";

const WORKSPACE_ID = uniqueTestId("ws_jira_connection_race");
const USER_A = uniqueTestId("user_jira_connection_race_a");
const USER_B = uniqueTestId("user_jira_connection_race_b");
const CLOUD_ID = uniqueTestId("cloud-jira-connection-race");
const SITE_URL = `https://${WORKSPACE_ID.replaceAll("_", "-")}.atlassian.net`;

describeDb("Jira connection principal serialization (DB-backed)", () => {
  const savedAllowedCloudIds = process.env.ATLASSIAN_ALLOWED_CLOUD_IDS;
  const savedEncryptionKey = process.env.APP_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.ATLASSIAN_ALLOWED_CLOUD_IDS = CLOUD_ID;
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString("base64");
    const now = nowIso();
    await sqlRun(
      `INSERT INTO workspaces (
         id, name, azure_org_name, azure_org_url, provider_id,
         provider_site_id, provider_site_name, provider_site_url, status, created_at, updated_at
       ) VALUES (
         @id, 'Jira connection race', NULL, NULL, 'jira-cloud',
         @cloudId, 'Jira connection race', @siteUrl,
         'active', @now, @now
       )`,
      { id: WORKSPACE_ID, cloudId: CLOUD_ID, siteUrl: SITE_URL, now },
    );
    await seedUser({ id: USER_A, email: `${USER_A}@itestflow.test` });
    await seedUser({ id: USER_B, email: `${USER_B}@itestflow.test` });
    await seedMembership({ workspaceId: WORKSPACE_ID, userId: USER_A, role: "owner" });
    await seedMembership({ workspaceId: WORKSPACE_ID, userId: USER_B, role: "owner" });
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [WORKSPACE_ID], userIds: [USER_A, USER_B] });
    if (savedAllowedCloudIds === undefined) delete process.env.ATLASSIAN_ALLOWED_CLOUD_IDS;
    else process.env.ATLASSIAN_ALLOWED_CLOUD_IDS = savedAllowedCloudIds;
    if (savedEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = savedEncryptionKey;
    await resetDatabaseForTests();
  });

  it("blocks concurrent owner stores on the workspace and commits exactly one sync principal", async () => {
    const locker = await getPool().connect();
    let lockOpen = false;
    let pendingStores: Array<Promise<void>> = [];
    try {
      await locker.query("BEGIN");
      lockOpen = true;
      await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [WORKSPACE_ID]);

      let firstSettled = false;
      let secondSettled = false;
      const first = storeJiraConnection({
        workspaceId: WORKSPACE_ID,
        userId: USER_A,
        cloudId: CLOUD_ID,
        accessToken: "access-a",
        refreshToken: "refresh-a",
        expiresInSeconds: 3600,
        scopes: "offline_access",
        isSyncPrincipal: true,
      }).finally(() => {
        firstSettled = true;
      });
      const second = storeJiraConnection({
        workspaceId: WORKSPACE_ID,
        userId: USER_B,
        cloudId: CLOUD_ID,
        accessToken: "access-b",
        refreshToken: "refresh-b",
        expiresInSeconds: 3600,
        scopes: "offline_access",
        isSyncPrincipal: true,
      }).finally(() => {
        secondSettled = true;
      });
      pendingStores = [first, second];

      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(firstSettled).toBe(false);
      expect(secondSettled).toBe(false);

      await locker.query("COMMIT");
      lockOpen = false;
      const results = await Promise.allSettled([first, second]);
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);

      const connections = await sqlAll<{ user_id: string; is_sync_principal: boolean }>(
        `SELECT user_id, is_sync_principal FROM jira_connections
         WHERE workspace_id = @workspaceId AND status = 'active'
         ORDER BY user_id`,
        { workspaceId: WORKSPACE_ID },
      );
      expect(connections).toHaveLength(2);
      expect(connections.filter((connection) => connection.is_sync_principal)).toHaveLength(1);
    } finally {
      if (lockOpen) await locker.query("ROLLBACK");
      locker.release();
      await Promise.allSettled(pendingStores);
    }
  });
});
