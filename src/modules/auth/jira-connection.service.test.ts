import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  encryptSecret: vi.fn(),
  decryptSecret: vi.fn(),
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

import {
  InvalidJiraCredentialsError,
  JiraSyncPrincipalError,
  markJiraConnectionInvalid,
  resolveJiraCredentials,
  resolveJiraSyncPrincipalCredentials,
  revokeJiraConnection,
  storeJiraConnection,
} from "./jira-connection.service";

const activeRow = {
  user_id: "user-1", email: "user@example.test", token_kind: "scoped", cloud_id: "cloud-a", status: "active",
  encrypted_api_token: "enc-token", api_token_iv: "iv-t", api_token_tag: "tag-t", key_version: 1,
};

describe("Jira API-token connection storage", () => {
  const transactionClient = { query: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlGet.mockReset();
    mocks.sqlRun.mockReset().mockResolvedValue(1);
    mocks.withTransaction.mockReset().mockImplementation(async (fn) => fn(transactionClient));
    mocks.encryptSecret.mockReset().mockReturnValue({ ciphertext: "enc-token", iv: "iv-t", tag: "tag-t", keyVersion: 1 });
    mocks.decryptSecret.mockReset();
  });

  it("stores the encrypted token with the normalized email and never passes plaintext to SQL", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce({ role: "owner" })
      .mockResolvedValueOnce(undefined);

    await storeJiraConnection({
      workspaceId: "ws-1",
      userId: "user-1",
      cloudId: "cloud-a",
      email: " User@Example.Test ",
      apiToken: "token-secret",
      tokenKind: "scoped",
      isSyncPrincipal: true,
    });

    expect(mocks.encryptSecret).toHaveBeenCalledWith("token-secret");
    expect(mocks.withTransaction).toHaveBeenCalledOnce();
    // Encryption happens before the transaction opens so the lock window stays minimal.
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
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("revoked_at = NULL");
    expect(params).toMatchObject({
      encryptedApiToken: "enc-token",
      apiTokenIv: "iv-t",
      email: "user@example.test",
      tokenKind: "scoped",
      isSyncPrincipal: true,
    });
    expect(JSON.stringify(params)).not.toContain("token-secret");
    expect(writeClient).toBe(transactionClient);
  });

  it("rejects incomplete inputs before encryption and SQL", async () => {
    for (const input of [
      { cloudId: " ", email: "user@example.test", apiToken: "token" },
      { cloudId: "cloud-a", email: " ", apiToken: "token" },
      { cloudId: "cloud-a", email: "user@example.test", apiToken: " " },
    ] as const) {
      await expect(storeJiraConnection({
        workspaceId: "ws-1", userId: "user-1", tokenKind: "scoped", ...input,
      })).rejects.toThrow("required");
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
      email: "user@example.test",
      apiToken: "token",
      tokenKind: "classic",
      isSyncPrincipal: true,
    })).rejects.toThrow("not authorized");
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });

  it("yields the sync-principal role to another user's active principal instead of violating its unique index", async () => {
    // Bootstrap-seeded owners (issue #186) make two owners per workspace a
    // normal state; the second owner's requested principal must compute to
    // false while another ACTIVE principal exists. An invalid principal keeps
    // its flag but is not 'active', so replacing its token reactivates in place.
    mocks.sqlGet
      .mockResolvedValueOnce({ role: "owner" })
      .mockResolvedValueOnce({ id: "other-connection" });

    await storeJiraConnection({
      workspaceId: "ws-1",
      userId: "user-2",
      cloudId: "cloud-a",
      email: "second@example.test",
      apiToken: "token",
      tokenKind: "scoped",
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
      email: "member@example.test",
      apiToken: "token",
      tokenKind: "classic",
      isSyncPrincipal: false,
    });

    expect(mocks.sqlGet).toHaveBeenCalledOnce();
    expect(mocks.sqlRun.mock.calls[0][1]).toMatchObject({ isSyncPrincipal: false, tokenKind: "classic" });
  });
});

describe("Jira credential resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlGet.mockReset();
    mocks.sqlRun.mockReset().mockResolvedValue(1);
    mocks.withTransaction.mockReset();
    mocks.decryptSecret.mockReset().mockReturnValue("plain-token");
  });

  it("resolves the caller's credential with a plain read - no transaction, no row locks", async () => {
    mocks.sqlGet.mockResolvedValueOnce(activeRow);

    await expect(resolveJiraCredentials({ workspaceId: "ws-1", userId: "user-1" })).resolves.toEqual({
      email: "user@example.test", apiToken: "plain-token", tokenKind: "scoped", cloudId: "cloud-a",
    });
    const [sql] = mocks.sqlGet.mock.calls[0];
    expect(sql).not.toContain("FOR UPDATE");
    expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain("w.status = 'active'");
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it("reports an invalid stored token as a typed error", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ ...activeRow, status: "invalid" });
    await expect(resolveJiraCredentials({ workspaceId: "ws-1", userId: "user-1" }))
      .rejects.toBeInstanceOf(InvalidJiraCredentialsError);
  });

  it("reports a missing connection", async () => {
    mocks.sqlGet.mockResolvedValueOnce(undefined);
    await expect(resolveJiraCredentials({ workspaceId: "ws-1", userId: "user-1" }))
      .rejects.toThrow("No active Jira connection");
  });

  it("distinguishes a missing sync principal from an invalid one by error code", async () => {
    mocks.sqlGet.mockResolvedValueOnce(undefined);
    await expect(resolveJiraSyncPrincipalCredentials("ws-1")).rejects.toMatchObject({
      code: "jira_sync_principal_missing",
    });

    mocks.sqlGet.mockResolvedValueOnce({ ...activeRow, status: "invalid" });
    const invalid = await resolveJiraSyncPrincipalCredentials("ws-1").catch((error) => error as JiraSyncPrincipalError);
    expect(invalid).toBeInstanceOf(JiraSyncPrincipalError);
    expect((invalid as JiraSyncPrincipalError).code).toBe("jira_sync_principal_invalid");
  });

  it("resolves an active sync principal with owner/admin gating in SQL", async () => {
    mocks.sqlGet.mockResolvedValueOnce(activeRow);
    await expect(resolveJiraSyncPrincipalCredentials("ws-1")).resolves.toEqual({
      userId: "user-1", email: "user@example.test", apiToken: "plain-token", tokenKind: "scoped", cloudId: "cloud-a",
    });
    const [sql] = mocks.sqlGet.mock.calls[0];
    expect(sql).toContain("c.is_sync_principal = true");
    expect(sql).toContain("m.role IN ('owner', 'admin')");
    expect(sql).toContain("w.provider_id = 'jira-cloud'");
  });
});

describe("Jira connection lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlRun.mockReset().mockResolvedValue(1);
  });

  it("marks a connection invalid on use-time 401 while KEEPING the principal flag and token", async () => {
    await markJiraConnectionInvalid("ws-1", "user-1");
    const [sql, params] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("status = 'invalid'");
    expect(sql).toContain("AND status = 'active'");
    expect(sql).not.toContain("is_sync_principal");
    expect(sql).not.toContain("encrypted_api_token");
    expect(params).toMatchObject({ workspaceId: "ws-1", userId: "user-1" });
  });

  it("is idempotent when the connection is already invalid or revoked", async () => {
    mocks.sqlRun.mockResolvedValueOnce(0);
    await expect(markJiraConnectionInvalid("ws-1", "user-1")).resolves.toBeUndefined();
  });

  it("revokes a connection, clears sync-principal ownership, and genuinely NULLs the secret", async () => {
    await revokeJiraConnection({ workspaceId: "ws-1", actorUserId: "user-1" });
    const [sql] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("status = 'revoked'");
    expect(sql).toContain("is_sync_principal = false");
    expect(sql).toContain("encrypted_api_token = NULL");
    expect(sql).toContain("key_version = NULL");
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
});
