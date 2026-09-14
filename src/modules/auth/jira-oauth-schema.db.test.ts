import { afterAll, beforeAll, expect, it } from "vitest";

import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedUser, seedWorkspace, uniqueTestId } from "@/test/db";

/**
 * Live behavior of migration 1710000048000's per-kind constraints. The pinning
 * test (jira-oauth-schema.test.ts) asserts the SQL text; this suite proves the
 * migrated database actually enforces it — including that a pre-48000-shaped
 * API-token insert (no credential_kind, no OAuth columns) still works and
 * lands as an api_token row, which is the additive-migration guarantee.
 */

const workspaceId = uniqueTestId("ws_oauthschema");
const tokenUserId = uniqueTestId("usr_oauthschema_token");
const oauthUserId = uniqueTestId("usr_oauthschema_oauth");
const scratchUserId = uniqueTestId("usr_oauthschema_scratch");

type ConnectionOverrides = Record<string, string | boolean | number | null>;

const TOKEN_SECRETS = {
  token_kind: "scoped",
  encrypted_api_token: "ct",
  api_token_iv: "iv",
  api_token_tag: "tag",
  key_version: 1,
} as const satisfies ConnectionOverrides;

const OAUTH_SECRETS = {
  encrypted_access_token: "act",
  access_token_iv: "aiv",
  access_token_tag: "atag",
  encrypted_refresh_token: "rct",
  refresh_token_iv: "riv",
  refresh_token_tag: "rtag",
  access_expires_at: "2099-01-01T00:00:00.000Z",
  key_version: 1,
} as const satisfies ConnectionOverrides;

async function insertConnection(input: { userId: string; overrides?: ConnectionOverrides }): Promise<string> {
  const id = uniqueTestId("jiraconn");
  const row: ConnectionOverrides = {
    id,
    workspace_id: workspaceId,
    user_id: input.userId,
    cloud_id: "cloud-1",
    email: "user@example.com",
    status: "active",
    is_sync_principal: false,
    created_at: nowIso(),
    updated_at: nowIso(),
    ...(input.overrides ?? {}),
  };
  const columns = Object.keys(row);
  await sqlRun(
    `INSERT INTO jira_connections (${columns.join(", ")}) VALUES (${columns.map((c) => `@${c}`).join(", ")})`,
    row,
  );
  return id;
}

describeDb("jira_connections dual-kind constraints (1710000048000)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl: `https://dev.azure.com/${workspaceId}` });
    await seedUser({ id: tokenUserId, email: "token@example.com" });
    await seedUser({ id: oauthUserId, email: "oauth@example.com" });
    await seedUser({ id: scratchUserId, email: "scratch@example.com" });
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [tokenUserId, oauthUserId, scratchUserId] });
  });

  it("accepts a pre-48000-shaped API-token insert and defaults credential_kind", async () => {
    const id = await insertConnection({ userId: tokenUserId, overrides: { ...TOKEN_SECRETS } });
    const row = await sqlGet<{ credential_kind: string }>(
      `SELECT credential_kind FROM jira_connections WHERE id = @id`,
      { id },
    );
    expect(row?.credential_kind).toBe("api_token");
  });

  it("rejects an active oauth row missing any part of the OAuth secret set", async () => {
    const missingRefresh: ConnectionOverrides = { ...OAUTH_SECRETS };
    delete missingRefresh.encrypted_refresh_token;
    await expect(
      insertConnection({
        userId: scratchUserId,
        overrides: { credential_kind: "oauth", ...missingRefresh },
      }),
    ).rejects.toThrow(/chk_jira_connections_active_secrets/);

    const missingExpiry: ConnectionOverrides = { ...OAUTH_SECRETS };
    delete missingExpiry.access_expires_at;
    await expect(
      insertConnection({
        userId: scratchUserId,
        overrides: { credential_kind: "oauth", ...missingExpiry },
      }),
    ).rejects.toThrow(/chk_jira_connections_active_secrets/);
  });

  it("accepts a complete active oauth row", async () => {
    const id = await insertConnection({
      userId: oauthUserId,
      overrides: { credential_kind: "oauth", ...OAUTH_SECRETS },
    });
    const row = await sqlGet<{ token_kind: string | null }>(
      `SELECT token_kind FROM jira_connections WHERE id = @id`,
      { id },
    );
    expect(row?.token_kind).toBeNull();
  });

  it("rejects reauthorization_required on an api_token row and allows it on oauth", async () => {
    await expect(
      insertConnection({
        userId: scratchUserId,
        overrides: { status: "reauthorization_required", ...TOKEN_SECRETS },
      }),
    ).rejects.toThrow(/chk_jira_connections_reauth_kind/);

    const id = await insertConnection({
      userId: scratchUserId,
      overrides: { credential_kind: "oauth", status: "reauthorization_required", ...OAUTH_SECRETS },
    });
    await sqlRun(`DELETE FROM jira_connections WHERE id = @id`, { id });
  });

  it("rejects an api_token row without token_kind at any status (kind hygiene)", async () => {
    // Non-active, all secrets cleared: only the hygiene constraint stands
    // between this row and bricking down()'s SET NOT NULL.
    await expect(
      insertConnection({
        userId: scratchUserId,
        overrides: { status: "revoked", token_kind: null },
      }),
    ).rejects.toThrow(/chk_jira_connections_kind_hygiene/);
    // Active without token_kind trips hygiene and the per-kind secret CHECK.
    await expect(
      insertConnection({
        userId: scratchUserId,
        overrides: { ...TOKEN_SECRETS, token_kind: null },
      }),
    ).rejects.toThrow(/chk_jira_connections_(kind_hygiene|active_secrets)/);
  });

  it("rejects 'invalid' on an oauth row — invalid is the api_token failure state", async () => {
    await expect(
      insertConnection({
        userId: scratchUserId,
        overrides: { credential_kind: "oauth", status: "invalid", ...OAUTH_SECRETS },
      }),
    ).rejects.toThrow(/chk_jira_connections_invalid_kind/);
  });

  it("rejects rows carrying the other kind's secrets (kind hygiene)", async () => {
    await expect(
      insertConnection({
        userId: scratchUserId,
        overrides: { credential_kind: "oauth", ...OAUTH_SECRETS, token_kind: "scoped" },
      }),
    ).rejects.toThrow(/chk_jira_connections_kind_hygiene/);

    await expect(
      insertConnection({
        userId: scratchUserId,
        overrides: { ...TOKEN_SECRETS, encrypted_access_token: "stray" },
      }),
    ).rejects.toThrow(/chk_jira_connections_kind_hygiene/);
  });

  it("still enforces one active sync principal per workspace across kinds", async () => {
    await sqlRun(
      `DELETE FROM jira_connections WHERE workspace_id = @workspaceId AND user_id IN (@tokenUserId, @oauthUserId)`,
      { workspaceId, tokenUserId, oauthUserId },
    );
    await insertConnection({
      userId: tokenUserId,
      overrides: { ...TOKEN_SECRETS, is_sync_principal: true },
    });
    await expect(
      insertConnection({
        userId: oauthUserId,
        overrides: { credential_kind: "oauth", ...OAUTH_SECRETS, is_sync_principal: true },
      }),
    ).rejects.toThrow(/idx_jira_connections_sync_principal/);
  });

  it("binds jira_oauth_states to its workspace with cascade delete", async () => {
    const cascadeWorkspaceId = uniqueTestId("ws_oauthstate");
    await seedWorkspace({ id: cascadeWorkspaceId, orgUrl: `https://dev.azure.com/${cascadeWorkspaceId}` });
    const stateId = uniqueTestId("jostate");
    const insertState = (id: string, stateHash: string) =>
      sqlRun(
        `INSERT INTO jira_oauth_states (
           id, state_hash, browser_binding_hash, return_to,
           selected_workspace_id, selected_site_url, selected_cloud_id,
           created_at, expires_at
         ) VALUES (@id, @stateHash, 'bind', '/dashboards', @workspaceId, 'https://x.atlassian.net', NULL, @now, @now)`,
        { id, stateHash, workspaceId: cascadeWorkspaceId, now: nowIso() },
      );
    await insertState(stateId, `hash_${stateId}`);
    await expect(insertState(uniqueTestId("jostate"), `hash_${stateId}`)).rejects.toThrow(/state_hash/);

    await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id: cascadeWorkspaceId });
    const survivor = await sqlGet<{ id: string }>(
      `SELECT id FROM jira_oauth_states WHERE id = @id`,
      { id: stateId },
    );
    expect(survivor).toBeUndefined();
  });
});
