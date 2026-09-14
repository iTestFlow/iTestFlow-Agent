import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const oauthMocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("./jira-oauth", async (importOriginal) => ({
  ...await importOriginal<typeof import("./jira-oauth")>(),
  refreshAtlassianOAuthTokens: oauthMocks.refresh,
}));

import {
  getPool,
  nowIso,
  resetDatabaseForTests,
  sqlAll,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { decryptSecret, encryptSecret } from "@/modules/security/encryption.service";
import { JiraBearerAuthError } from "@/modules/integrations/jira-cloud/jira-http";
import { cleanupFixtures, describeDb, seedMembership, seedUser, uniqueTestId } from "@/test/db";
import { AtlassianOAuthError, AtlassianReauthorizationRequiredError } from "./jira-oauth";
import {
  markJiraConnectionInvalid,
  markJiraConnectionReauthorizationRequired,
  resolveJiraCredentials,
  resolveJiraSyncPrincipalCredentials,
  storeJiraConnection,
  revokeJiraConnection,
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

  async function invalidateCurrentToken(userId: string) {
    const credential = await resolveJiraCredentials({ workspaceId: WORKSPACE_ID, userId });
    if (credential.kind !== "api_token") throw new Error("expected an API token");
    await markJiraConnectionInvalid(WORKSPACE_ID, userId, credential.revision);
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
    await invalidateCurrentToken(USER_A);
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
    await invalidateCurrentToken(USER_A);
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

const WS_DUAL = uniqueTestId("ws_jira_dual_kind");
const USER_DUAL = uniqueTestId("user_jira_dual_kind");
const CLOUD_DUAL = uniqueTestId("cloud-jira-dual-kind");

describeDb("Jira dual-kind credential lifecycle (DB-backed)", () => {
  const savedEncryptionKey = process.env.APP_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
    const now = nowIso();
    await sqlRun(
      `INSERT INTO workspaces (
         id, name, azure_org_name, azure_org_url, provider_id,
         provider_site_id, provider_site_name, provider_site_url, status, created_at, updated_at
       ) VALUES (
         @id, 'Jira dual kind', NULL, NULL, 'jira-cloud',
         @cloudId, 'Jira dual kind', @siteUrl, 'active', @now, @now
       )`,
      { id: WS_DUAL, cloudId: CLOUD_DUAL, siteUrl: `https://${WS_DUAL.replaceAll("_", "-")}.atlassian.net`, now },
    );
    await seedUser({ id: USER_DUAL, email: `${USER_DUAL}@itestflow.test` });
    await seedMembership({ workspaceId: WS_DUAL, userId: USER_DUAL, role: "owner" });
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [WS_DUAL], userIds: [USER_DUAL] });
    if (savedEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = savedEncryptionKey;
    await resetDatabaseForTests();
  });

  beforeEach(() => {
    oauthMocks.refresh.mockReset();
  });

  function storeToken(token: string) {
    return storeJiraConnection({
      workspaceId: WS_DUAL, userId: USER_DUAL, cloudId: CLOUD_DUAL,
      email: `${USER_DUAL}@itestflow.test`, apiToken: token, tokenKind: "scoped", isSyncPrincipal: true,
    });
  }

  function storeOAuth(input: { access: string; refresh: string; expiresInSeconds?: number }) {
    return storeJiraConnection({
      credentialKind: "oauth", workspaceId: WS_DUAL, userId: USER_DUAL, cloudId: CLOUD_DUAL,
      email: `${USER_DUAL}@itestflow.test`, accessToken: input.access, refreshToken: input.refresh,
      expiresInSeconds: input.expiresInSeconds ?? 3600, isSyncPrincipal: true,
    });
  }

  async function connectionRow() {
    const row = await sqlGet<Record<string, unknown>>(
      `SELECT credential_kind, status, is_sync_principal, token_kind,
              encrypted_api_token, encrypted_access_token, encrypted_refresh_token,
              refresh_token_iv, refresh_token_tag, key_version, access_expires_at
       FROM jira_connections WHERE workspace_id = @ws AND user_id = @user`,
      { ws: WS_DUAL, user: USER_DUAL },
    );
    if (!row) throw new Error("connection row missing");
    return row;
  }

  it("latest login wins across kinds, NULLing the other kind's secrets", async () => {
    await storeToken("token-1");
    expect(await connectionRow()).toMatchObject({ credential_kind: "api_token", encrypted_access_token: null });

    await storeOAuth({ access: "access-1", refresh: "refresh-1" });
    const asOAuth = await connectionRow();
    expect(asOAuth).toMatchObject({ credential_kind: "oauth", token_kind: null, encrypted_api_token: null, status: "active" });
    expect(asOAuth.encrypted_access_token).toBeTruthy();

    const credential = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    expect(credential.kind).toBe("oauth");

    await storeToken("token-2");
    expect(await connectionRow()).toMatchObject({
      credential_kind: "api_token", token_kind: "scoped",
      encrypted_access_token: null, encrypted_refresh_token: null, access_expires_at: null,
    });
  });

  it.each(["replacement-token", "original-token"])("a late API-token failure leaves the replacement active (%s)", async (replacement) => {
    await storeToken("original-token");
    const rejected = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    if (rejected.kind !== "api_token") throw new Error("expected an API token");
    await storeToken(replacement);
    await markJiraConnectionInvalid(WS_DUAL, USER_DUAL, rejected.revision);
    expect(await connectionRow()).toMatchObject({ status: "active", is_sync_principal: true });
    await expect(resolveJiraSyncPrincipalCredentials(WS_DUAL)).resolves.toMatchObject({ apiToken: replacement });
  });

  it("a late final OAuth 401 leaves a reconnected grant active", async () => {
    await storeOAuth({ access: "original-access", refresh: "original-refresh" });
    const credential = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    if (credential.kind !== "oauth") throw new Error("expected OAuth");
    const rejected = await credential.getAccessToken();
    await storeOAuth({ access: "replacement-access", refresh: "replacement-refresh" });
    await markJiraConnectionReauthorizationRequired(WS_DUAL, USER_DUAL, rejected.revision);
    expect(await connectionRow()).toMatchObject({ status: "active", is_sync_principal: true });
  });

  it("a delayed forced refresh reuses a reconnect even after the supplier served its new token", async () => {
    oauthMocks.refresh.mockResolvedValue({ accessToken: "unnecessary-rotation", refreshToken: "rotated-refresh", expiresInSeconds: 3600, scope: "", tokenType: "Bearer" });
    await storeOAuth({ access: "old-access", refresh: "old-refresh" });
    const credential = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    if (credential.kind !== "oauth") throw new Error("expected OAuth");
    const rejected = await credential.getAccessToken();
    await storeOAuth({ access: "new-access", refresh: "new-refresh" });
    const current = await credential.getAccessToken();
    const retried = await credential.getAccessToken({ forceRefresh: true, rejectedRevision: rejected.revision });
    expect(retried).toEqual(current);
    expect(oauthMocks.refresh).not.toHaveBeenCalled();
  });

  it("invalidation rechecks a replacement after waiting for its row lock", async () => {
    await storeToken("original-token");
    const rejected = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    if (rejected.kind !== "api_token") throw new Error("expected an API token");
    const locker = await getPool().connect();
    let lockOpen = false;
    let invalidation: Promise<void> | undefined;
    try {
      await locker.query("BEGIN");
      lockOpen = true;
      await locker.query("SELECT id FROM jira_connections WHERE workspace_id = $1 AND user_id = $2 FOR UPDATE", [WS_DUAL, USER_DUAL]);
      let settled = false;
      invalidation = markJiraConnectionInvalid(WS_DUAL, USER_DUAL, rejected.revision).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(settled).toBe(false);
      // Simulate a replacement committed while the old response waits. The
      // encryption tuple changes even if the connection id stays the same.
      const replacement = encryptSecret("replacement-token");
      await locker.query("UPDATE jira_connections SET encrypted_api_token = $3, api_token_iv = $4, api_token_tag = $5, key_version = $6 WHERE workspace_id = $1 AND user_id = $2", [WS_DUAL, USER_DUAL, replacement.ciphertext, replacement.iv, replacement.tag, replacement.keyVersion]);
      await locker.query("COMMIT");
      lockOpen = false;
      await invalidation;
      expect(await connectionRow()).toMatchObject({ status: "active", is_sync_principal: true });
      await expect(resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL })).resolves.toMatchObject({ apiToken: "replacement-token" });
    } finally {
      if (lockOpen) await locker.query("ROLLBACK");
      locker.release();
      await invalidation;
    }
  });

  it("a current OAuth rejection invalidates only that grant and cannot change a later API token or revoke", async () => {
    await storeOAuth({ access: "current-access", refresh: "current-refresh" });
    const credential = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    if (credential.kind !== "oauth") throw new Error("expected OAuth");
    const rejected = await credential.getAccessToken();
    await markJiraConnectionReauthorizationRequired(WS_DUAL, USER_DUAL, rejected.revision);
    expect(await connectionRow()).toMatchObject({ status: "reauthorization_required", is_sync_principal: true });
    await storeToken("other-kind");
    await markJiraConnectionReauthorizationRequired(WS_DUAL, USER_DUAL, rejected.revision);
    expect(await connectionRow()).toMatchObject({ status: "active", credential_kind: "api_token" });
    await revokeJiraConnection({ workspaceId: WS_DUAL, actorUserId: USER_DUAL });
    await markJiraConnectionReauthorizationRequired(WS_DUAL, USER_DUAL, rejected.revision);
    expect(await connectionRow()).toMatchObject({ status: "revoked", is_sync_principal: false });
  });

  it("collapses a concurrent expiring-token refresh to exactly one rotation", async () => {
    await storeOAuth({ access: "stale-access", refresh: "stale-refresh", expiresInSeconds: 30 });
    oauthMocks.refresh.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresInSeconds: 3600, scope: "", tokenType: "Bearer" };
    });

    const first = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    const second = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    if (first.kind !== "oauth" || second.kind !== "oauth") throw new Error("expected oauth credentials");

    const [tokenA, tokenB] = await Promise.all([first.getAccessToken(), second.getAccessToken()]);
    expect(tokenA).toEqual({ accessToken: "rotated-access", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(tokenB).toEqual(tokenA);
    expect(oauthMocks.refresh).toHaveBeenCalledTimes(1);

    // The rotated refresh token is the one persisted — losing it would kill
    // the grant at the next refresh.
    const row = await connectionRow();
    expect(decryptSecret({
      ciphertext: String(row.encrypted_refresh_token),
      iv: String(row.refresh_token_iv),
      tag: String(row.refresh_token_tag),
      keyVersion: Number(row.key_version),
    })).toBe("rotated-refresh");
  });

  it("flips to reauthorization_required on a terminal refresh, keeps everything, and recovers via reconnect", async () => {
    await storeOAuth({ access: "dying-access", refresh: "dying-refresh", expiresInSeconds: 30 });
    oauthMocks.refresh.mockRejectedValue(new AtlassianReauthorizationRequiredError());

    const credential = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    if (credential.kind !== "oauth") throw new Error("expected an oauth credential");
    const error = await credential.getAccessToken().catch((caught) => caught as JiraBearerAuthError);
    expect(error).toBeInstanceOf(JiraBearerAuthError);
    expect((error as JiraBearerAuthError).reason).toBe("reauthorization_required");

    const flipped = await connectionRow();
    expect(flipped).toMatchObject({ status: "reauthorization_required", is_sync_principal: true });
    expect(flipped.encrypted_refresh_token).toBeTruthy();

    await expect(resolveJiraSyncPrincipalCredentials(WS_DUAL)).rejects.toMatchObject({
      code: "jira_sync_principal_reauthorization_required",
    });

    // A fresh consent through the same upsert restores polling in place.
    await storeOAuth({ access: "renewed-access", refresh: "renewed-refresh" });
    const restored = await resolveJiraSyncPrincipalCredentials(WS_DUAL);
    expect(restored).toMatchObject({ userId: USER_DUAL, kind: "oauth" });
    expect(await connectionRow()).toMatchObject({ status: "active", is_sync_principal: true });
  });

  it("leaves the row fully intact on a transient refresh failure", async () => {
    await storeOAuth({ access: "held-access", refresh: "held-refresh", expiresInSeconds: 30 });
    const before = await connectionRow();
    oauthMocks.refresh.mockRejectedValue(new AtlassianOAuthError("Atlassian authorization is unavailable. Try again later."));

    const credential = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    if (credential.kind !== "oauth") throw new Error("expected an oauth credential");
    const error = await credential.getAccessToken().catch((caught) => caught as JiraBearerAuthError);
    expect((error as JiraBearerAuthError).reason).toBe("unavailable");

    const after = await connectionRow();
    expect(after).toMatchObject({
      status: "active",
      encrypted_access_token: before.encrypted_access_token,
      encrypted_refresh_token: before.encrypted_refresh_token,
      access_expires_at: before.access_expires_at,
    });
  });

  it("marks invalid only api_token rows — an oauth row is untouched by the token hook", async () => {
    await storeToken("previous-api-token");
    const previous = await resolveJiraCredentials({ workspaceId: WS_DUAL, userId: USER_DUAL });
    if (previous.kind !== "api_token") throw new Error("expected an API token");
    await storeOAuth({ access: "guard-access", refresh: "guard-refresh" });
    await markJiraConnectionInvalid(WS_DUAL, USER_DUAL, previous.revision);
    expect(await connectionRow()).toMatchObject({ status: "active", credential_kind: "oauth" });
  });
});
