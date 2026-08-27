import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  encryptSecret: vi.fn(),
  decryptSecret: vi.fn(),
  refreshTokens: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  createId: (prefix: string) => `${prefix}_fixed`,
  nowIso: () => "2026-08-13T10:00:00.000Z",
  sqlGet: mocks.sqlGet,
  sqlRun: mocks.sqlRun,
  withTransaction: mocks.withTransaction,
}));
vi.mock("@/modules/security/encryption.service", () => ({
  encryptSecret: mocks.encryptSecret,
  decryptSecret: mocks.decryptSecret,
}));
vi.mock("./jira-oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jira-oauth")>();
  return { ...actual, refreshAtlassianOAuthTokens: mocks.refreshTokens };
});

import { resolveJiraAccessToken, resolveJiraSyncPrincipalAccessToken, revokeJiraConnection, storeJiraConnection } from "./jira-connection.service";

describe("Jira OAuth connection storage", () => {
  const transactionClient = { query: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ATLASSIAN_ALLOWED_CLOUD_IDS", "cloud-a");
    mocks.sqlGet.mockReset();
    mocks.sqlRun.mockReset().mockResolvedValue(1);
    mocks.withTransaction.mockReset().mockImplementation(async (fn) => fn(transactionClient));
    mocks.encryptSecret.mockReset();
    mocks.decryptSecret.mockReset();
    mocks.refreshTokens.mockReset();
    mocks.encryptSecret
      .mockReturnValueOnce({ ciphertext: "enc-access", iv: "iv-a", tag: "tag-a", keyVersion: 1 })
      .mockReturnValueOnce({ ciphertext: "enc-refresh", iv: "iv-r", tag: "tag-r", keyVersion: 1 });
  });

  it("serializes an expired token refresh and atomically stores both rotated tokens", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ role: "member" })
      .mockResolvedValueOnce({
        id: "conn-1", encrypted_access_token: "old-access", access_token_iv: "iv-a", access_token_tag: "tag-a",
        encrypted_refresh_token: "old-refresh", refresh_token_iv: "iv-r", refresh_token_tag: "tag-r",
        key_version: 1, access_expires_at: "2026-08-13T09:59:00.000Z",
      });
    mocks.decryptSecret.mockReturnValueOnce("old-refresh-secret");
    mocks.refreshTokens.mockResolvedValue({
      accessToken: "plain-new-access", refreshToken: "plain-new-refresh", expiresInSeconds: 3600,
      scope: "offline_access", tokenType: "Bearer",
    });
    mocks.encryptSecret
      .mockReset()
      .mockReturnValueOnce({ ciphertext: "opaque-a", iv: "iv-na", tag: "tag-na", keyVersion: 1 })
      .mockReturnValueOnce({ ciphertext: "opaque-r", iv: "iv-nr", tag: "tag-nr", keyVersion: 1 });

    await expect(resolveJiraAccessToken({ workspaceId: "ws-1", userId: "user-1" })).resolves.toBe("plain-new-access");
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("FOR UPDATE OF w, m");
    expect(mocks.sqlGet.mock.calls[1][0]).toContain("FOR UPDATE OF c");
    expect(mocks.sqlGet.mock.calls[0][2]).toBe(transactionClient);
    expect(mocks.sqlGet.mock.calls[1][2]).toBe(transactionClient);
    expect(mocks.refreshTokens).toHaveBeenCalledWith("old-refresh-secret");
    const update = mocks.sqlRun.mock.calls.find(([sql]) => sql.includes("UPDATE jira_connections"));
    expect(update?.[1]).toMatchObject({ encryptedAccessToken: "opaque-a", encryptedRefreshToken: "opaque-r" });
    expect(JSON.stringify(update?.[1])).not.toContain("plain-new-access");
    expect(JSON.stringify(update?.[1])).not.toContain("plain-new-refresh");
  });

  it("resolves the active workspace sync principal through the normal refresh path", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ user_id: "sync-user" })
      .mockResolvedValueOnce({ role: "owner" })
      .mockResolvedValueOnce({
        id: "conn-1", encrypted_access_token: "access", access_token_iv: "iv-a", access_token_tag: "tag-a",
        encrypted_refresh_token: "refresh", refresh_token_iv: "iv-r", refresh_token_tag: "tag-r",
        key_version: 1, access_expires_at: "2026-08-13T12:00:00.000Z",
      });
    mocks.decryptSecret.mockReturnValueOnce("sync-access-token");

    await expect(resolveJiraSyncPrincipalAccessToken("ws-1")).resolves.toEqual({
      userId: "sync-user", accessToken: "sync-access-token",
    });
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("is_sync_principal = true");
    expect(mocks.sqlGet.mock.calls[0][0]).toContain("w.provider_id = 'jira-cloud'");
  });

  it("revokes a connection and clears sync-principal ownership without deleting audit-safe metadata", async () => {
    await revokeJiraConnection({ workspaceId: "ws-1", actorUserId: "user-1" });
    const [sql] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("status = 'revoked'");
    expect(sql).toContain("is_sync_principal = false");
    expect(sql).toContain("encrypted_access_token = ''");
    expect(sql).toContain("encrypted_refresh_token = ''");
    expect(sql).toContain("JOIN workspace_members actor");
    expect(sql).toContain("JOIN workspace_members target");
    expect(sql).toContain("actor.role = 'admin' AND target.role = 'member'");
  });

  it("fails closed when the actor cannot revoke the target connection", async () => {
    mocks.sqlRun.mockResolvedValue(0);
    await expect(revokeJiraConnection({
      workspaceId: "ws-1", actorUserId: "member-1", targetUserId: "user-2",
    })).rejects.toThrow("not authorized");
  });

  it("marks a terminal refresh rejection for reauthorization outside the rolled-back refresh transaction", async () => {
    const { AtlassianReauthorizationRequiredError } = await import("./jira-oauth");
    mocks.sqlGet
      .mockResolvedValueOnce({ role: "member" })
      .mockResolvedValueOnce({
        id: "conn-1", encrypted_access_token: "old-access", access_token_iv: "iv-a", access_token_tag: "tag-a",
        encrypted_refresh_token: "old-refresh", refresh_token_iv: "iv-r", refresh_token_tag: "tag-r",
        key_version: 1, access_expires_at: "2026-08-13T09:59:00.000Z",
      });
    mocks.decryptSecret.mockReturnValue("old-refresh-secret");
    mocks.refreshTokens.mockRejectedValue(new AtlassianReauthorizationRequiredError());
    await expect(resolveJiraAccessToken({ workspaceId: "ws-1", userId: "user-1" }))
      .rejects.toBeInstanceOf(AtlassianReauthorizationRequiredError);
    const statusUpdate = mocks.sqlRun.mock.calls.find(([sql]) => sql.includes("reauthorization_required"));
    expect(statusUpdate?.[0]).toContain("is_sync_principal = false");
    expect(statusUpdate?.[0]).toContain("WHERE id = @id");
  });

  it("stores encrypted access and refresh tokens and never passes plaintext to SQL", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ role: "owner" })
      .mockResolvedValueOnce(undefined);

    await storeJiraConnection({
      workspaceId: "ws-1",
      userId: "user-1",
      cloudId: "cloud-a",
      accessToken: " access-secret ",
      refreshToken: " refresh-secret ",
      expiresInSeconds: 3600,
      scopes: "offline_access read:jira-work",
      isSyncPrincipal: true,
    });

    expect(mocks.encryptSecret).toHaveBeenNthCalledWith(1, " access-secret ");
    expect(mocks.encryptSecret).toHaveBeenNthCalledWith(2, " refresh-secret ");
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    expect(mocks.encryptSecret.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.withTransaction.mock.invocationCallOrder[0]);
    const [authorizationSql, authorizationParams, authorizationClient] = mocks.sqlGet.mock.calls[0];
    expect(authorizationSql).toContain("FOR UPDATE OF w, m");
    expect(authorizationSql).toContain("w.provider_site_id = @cloudId");
    expect(authorizationSql).toContain("m.status = 'active'");
    expect(authorizationSql).toContain("m.role IN ('owner', 'admin')");
    expect(authorizationParams).toMatchObject({ workspaceId: "ws-1", userId: "user-1", cloudId: "cloud-a" });
    expect(authorizationClient).toBe(transactionClient);
    const [principalSql, , principalClient] = mocks.sqlGet.mock.calls[1];
    expect(principalSql).toContain("other.user_id <> @userId");
    expect(principalSql).toContain("other.is_sync_principal = true");
    expect(principalSql).toContain("FOR UPDATE");
    expect(principalClient).toBe(transactionClient);
    const [sql, params, writeClient] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("INSERT INTO jira_connections");
    expect(sql).toContain("ON CONFLICT (workspace_id, user_id) DO UPDATE");
    expect(params).toMatchObject({
      encryptedAccessToken: "enc-access",
      encryptedRefreshToken: "enc-refresh",
      accessTokenIv: "iv-a",
      refreshTokenIv: "iv-r",
      isSyncPrincipal: true,
    });
    expect(JSON.stringify(params)).not.toContain("access-secret");
    expect(JSON.stringify(params)).not.toContain("refresh-secret");
    expect(params.accessExpiresAt).toBe("2026-08-13T11:00:00.000Z");
    expect(writeClient).toBe(transactionClient);
  });

  it("rejects invalid or unapproved inputs before encryption and SQL", async () => {
    for (const input of [
      { cloudId: "cloud-c", accessToken: "access", refreshToken: "refresh", expiresInSeconds: 3600 },
      { cloudId: "cloud-a", accessToken: " ", refreshToken: "refresh", expiresInSeconds: 3600 },
      { cloudId: "cloud-a", accessToken: "access", refreshToken: "refresh", expiresInSeconds: 0 },
    ]) {
      await expect(storeJiraConnection({
        workspaceId: "ws-1", userId: "user-1", scopes: "offline_access", ...input,
      })).rejects.toThrow();
    }
    expect(mocks.encryptSecret).not.toHaveBeenCalled();
    expect(mocks.sqlRun).not.toHaveBeenCalled();
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it("fails closed when workspace site, membership, or sync-principal role does not authorize the write", async () => {
    mocks.sqlGet.mockResolvedValueOnce(undefined);
    await expect(storeJiraConnection({
      workspaceId: "ws-other",
      userId: "user-1",
      cloudId: "cloud-a",
      accessToken: "access",
      refreshToken: "refresh",
      expiresInSeconds: 3600,
      scopes: "offline_access",
      isSyncPrincipal: true,
    })).rejects.toThrow("not authorized");
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });

  it("yields the sync-principal role to another user's active principal instead of violating its unique index", async () => {
    // Bootstrap-seeded owners (issue #186) make two owners per workspace a
    // normal state; the second owner's requested principal must compute to
    // false in SQL while another active principal exists.
    mocks.sqlGet
      .mockResolvedValueOnce({ role: "owner" })
      .mockResolvedValueOnce({ id: "other-connection" });

    await storeJiraConnection({
      workspaceId: "ws-1",
      userId: "user-2",
      cloudId: "cloud-a",
      accessToken: "access",
      refreshToken: "refresh",
      expiresInSeconds: 3600,
      scopes: "offline_access",
      isSyncPrincipal: true,
    });

    const [, params] = mocks.sqlRun.mock.calls[0];
    expect(params.isSyncPrincipal).toBe(false);
  });

  it("keeps non-principal connection storage available to an active member", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ role: "member" });

    await storeJiraConnection({
      workspaceId: "ws-1",
      userId: "member-1",
      cloudId: "cloud-a",
      accessToken: "access",
      refreshToken: "refresh",
      expiresInSeconds: 3600,
      scopes: "offline_access",
      isSyncPrincipal: false,
    });

    expect(mocks.sqlGet).toHaveBeenCalledOnce();
    expect(mocks.sqlRun.mock.calls[0][1]).toMatchObject({ isSyncPrincipal: false });
  });
});
