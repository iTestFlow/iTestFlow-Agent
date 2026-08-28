import { afterAll, beforeAll, expect, it } from "vitest";

import {
  getPool,
  nowIso,
  resetDatabaseForTests,
  sqlAll,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedMembership, seedUser, uniqueTestId } from "@/test/db";
import {
  markJiraConnectionInvalid,
  resolveJiraSyncPrincipalCredentials,
  storeJiraConnection,
} from "./jira-connection.service";

const WORKSPACE_ID = uniqueTestId("ws_jira_connection_race");
const USER_A = uniqueTestId("user_jira_connection_race_a");
const USER_B = uniqueTestId("user_jira_connection_race_b");
const CLOUD_ID = uniqueTestId("cloud-jira-connection-race");
const SITE_URL = `https://${WORKSPACE_ID.replaceAll("_", "-")}.atlassian.net`;

describeDb("Jira connection principal lifecycle (DB-backed)", () => {
  const savedEncryptionKey = process.env.APP_ENCRYPTION_KEY;

  beforeAll(async () => {
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
    if (savedEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = savedEncryptionKey;
    await resetDatabaseForTests();
  });

  function store(userId: string, token: string, isSyncPrincipal = true) {
    return storeJiraConnection({
      workspaceId: WORKSPACE_ID,
      userId,
      cloudId: CLOUD_ID,
      email: `${userId}@itestflow.test`,
      apiToken: token,
      tokenKind: "scoped",
      isSyncPrincipal,
    });
  }

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
      const first = store(USER_A, "token-a").finally(() => {
        firstSettled = true;
      });
      const second = store(USER_B, "token-b").finally(() => {
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

  it("keeps the invalid principal's flag, lets another owner claim, and yields on reactivation", async () => {
    // Deterministic starting state: A is the sole active principal.
    await sqlRun(`DELETE FROM jira_connections WHERE workspace_id = @workspaceId`, { workspaceId: WORKSPACE_ID });
    await store(USER_A, "token-a");
    await store(USER_B, "token-b"); // yields to A's active principal

    // A use-time 401 invalidates A's token but KEEPS the principal flag, so a
    // plain token replacement restores polling without a handover.
    await markJiraConnectionInvalid(WORKSPACE_ID, USER_A);
    const invalid = await sqlGet<{ is_sync_principal: boolean; status: string }>(
      `SELECT is_sync_principal, status FROM jira_connections WHERE workspace_id = @workspaceId AND user_id = @userId`,
      { workspaceId: WORKSPACE_ID, userId: USER_A },
    );
    expect(invalid).toMatchObject({ is_sync_principal: true, status: "invalid" });
    await expect(resolveJiraSyncPrincipalCredentials(WORKSPACE_ID)).rejects.toMatchObject({
      code: "jira_sync_principal_invalid",
    });

    // A replaces the token before anyone else claims: polling resumes in place.
    await store(USER_A, "token-a-replaced");
    await expect(resolveJiraSyncPrincipalCredentials(WORKSPACE_ID)).resolves.toMatchObject({
      userId: USER_A, apiToken: "token-a-replaced", tokenKind: "scoped", cloudId: CLOUD_ID,
    });

    // A goes invalid again and B claims principal in the meantime.
    await markJiraConnectionInvalid(WORKSPACE_ID, USER_A);
    await store(USER_B, "token-b-2");
    await expect(resolveJiraSyncPrincipalCredentials(WORKSPACE_ID)).resolves.toMatchObject({ userId: USER_B });

    // A's later reactivation must yield to B through the arbitrating upsert.
    await store(USER_A, "token-a-3");
    const principals = await sqlAll<{ user_id: string }>(
      `SELECT user_id FROM jira_connections
       WHERE workspace_id = @workspaceId AND is_sync_principal = true AND status = 'active'`,
      { workspaceId: WORKSPACE_ID },
    );
    expect(principals).toEqual([{ user_id: USER_B }]);
  });

  it("enforces the complete-encrypted-token CHECK on active rows", async () => {
    await expect(sqlRun(
      `UPDATE jira_connections
       SET encrypted_api_token = NULL
       WHERE workspace_id = @workspaceId AND user_id = @userId AND status = 'active'`,
      { workspaceId: WORKSPACE_ID, userId: USER_A },
    )).rejects.toThrow();
  });
});
