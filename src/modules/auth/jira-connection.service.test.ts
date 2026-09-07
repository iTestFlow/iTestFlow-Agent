import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  encryptSecret: vi.fn(),
  decryptSecret: vi.fn(),
  withTransaction: vi.fn(),
  refreshTokens: vi.fn(),
}));

vi.mock("./jira-oauth", async (importOriginal) => ({
  ...await importOriginal<typeof import("./jira-oauth")>(),
  refreshAtlassianOAuthTokens: mocks.refreshTokens,
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
  JiraReauthorizationRequiredError,
  JiraSyncPrincipalError,
  jiraOnUnauthorized,
  markJiraConnectionInvalid,
  markJiraConnectionReauthorizationRequired,
  resolveJiraCredentials,
  resolveJiraSyncPrincipalCredentials,
  revokeJiraConnection,
  storeJiraConnection,
} from "./jira-connection.service";
import { AtlassianReauthorizationRequiredError, AtlassianOAuthError } from "./jira-oauth";
import { JiraBearerAuthError } from "@/modules/integrations/jira-cloud/jira-http";

const activeRow = {
  id: "jiraconn_row",
  user_id: "user-1", email: "user@example.test", credential_kind: "api_token", token_kind: "scoped", cloud_id: "cloud-a", status: "active",
  encrypted_api_token: "enc-token", api_token_iv: "iv-t", api_token_tag: "tag-t", key_version: 1,
};

const oauthRow = {
  id: "jiraconn_row", user_id: "user-1", email: "user@example.test", credential_kind: "oauth", token_kind: null, cloud_id: "cloud-a", status: "active",
  encrypted_api_token: null, api_token_iv: null, api_token_tag: null,
  encrypted_access_token: "enc-access", access_token_iv: "iv-a", access_token_tag: "tag-a",
  encrypted_refresh_token: "enc-refresh", refresh_token_iv: "iv-r", refresh_token_tag: "tag-r",
  key_version: 1, access_expires_at: "2026-08-13T11:00:00.000Z",
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

  it("stores an OAuth connection: both secrets encrypted, token columns NULLed, expiry computed", async () => {
    mocks.encryptSecret
      .mockReturnValueOnce({ ciphertext: "enc-access", iv: "iv-a", tag: "tag-a", keyVersion: 1 })
      .mockReturnValueOnce({ ciphertext: "enc-refresh", iv: "iv-r", tag: "tag-r", keyVersion: 1 });
    mocks.sqlGet.mockResolvedValueOnce({ role: "owner" }).mockResolvedValueOnce(undefined);

    await storeJiraConnection({
      credentialKind: "oauth",
      workspaceId: "ws-1",
      userId: "user-1",
      cloudId: "cloud-a",
      email: " User@Example.Test ",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresInSeconds: 3600,
      isSyncPrincipal: true,
    });

    const [sql, params] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (workspace_id, user_id) DO UPDATE");
    expect(params).toMatchObject({
      credentialKind: "oauth",
      tokenKind: null,
      encryptedApiToken: null,
      encryptedAccessToken: "enc-access",
      encryptedRefreshToken: "enc-refresh",
      accessExpiresAt: "2026-08-13T11:00:00.000Z",
      email: "user@example.test",
    });
    expect(JSON.stringify(params)).not.toContain("access-secret");
    expect(JSON.stringify(params)).not.toContain("refresh-secret");
  });

  it("stores an API-token connection with NULLed OAuth columns — latest wins by overwriting the other kind", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ role: "member" });
    await storeJiraConnection({
      workspaceId: "ws-1", userId: "user-1", cloudId: "cloud-a",
      email: "user@example.test", apiToken: "token", tokenKind: "scoped",
    });
    const [sql, params] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("credential_kind = excluded.credential_kind");
    expect(sql).toContain("encrypted_access_token = excluded.encrypted_access_token");
    expect(params).toMatchObject({
      credentialKind: "api_token",
      encryptedAccessToken: null,
      encryptedRefreshToken: null,
      accessExpiresAt: null,
    });
  });

  it("rejects an OAuth store whose encrypted pair spans two key versions", async () => {
    mocks.encryptSecret
      .mockReturnValueOnce({ ciphertext: "enc-access", iv: "iv-a", tag: "tag-a", keyVersion: 1 })
      .mockReturnValueOnce({ ciphertext: "enc-refresh", iv: "iv-r", tag: "tag-r", keyVersion: 2 });
    await expect(storeJiraConnection({
      credentialKind: "oauth", workspaceId: "ws-1", userId: "user-1", cloudId: "cloud-a",
      email: "user@example.test", accessToken: "a", refreshToken: "r", expiresInSeconds: 3600,
    })).rejects.toThrow("key version");
    expect(mocks.withTransaction).not.toHaveBeenCalled();
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
      kind: "api_token", email: "user@example.test", apiToken: "plain-token", tokenKind: "scoped", cloudId: "cloud-a",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const [sql] = mocks.sqlGet.mock.calls[0];
    expect(sql).not.toContain("FOR UPDATE");
    expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain("w.status = 'active'");
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it("resolves an OAuth credential as a bearer supplier without decrypting anything up front", async () => {
    mocks.sqlGet.mockResolvedValueOnce(oauthRow);
    const credential = await resolveJiraCredentials({ workspaceId: "ws-1", userId: "user-1" });
    expect(credential).toMatchObject({ kind: "oauth", email: "user@example.test", cloudId: "cloud-a" });
    expect(credential.kind === "oauth" && typeof credential.getAccessToken).toBe("function");
    expect(mocks.decryptSecret).not.toHaveBeenCalled();
  });

  it("reports a reauthorization-required OAuth connection as a typed error", async () => {
    mocks.sqlGet.mockResolvedValueOnce({ ...oauthRow, status: "reauthorization_required" });
    await expect(resolveJiraCredentials({ workspaceId: "ws-1", userId: "user-1" }))
      .rejects.toBeInstanceOf(JiraReauthorizationRequiredError);
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

  it("uses policy-neutral Settings recovery messages without renaming error codes", () => {
    const invalid = new InvalidJiraCredentialsError();
    expect(invalid.message).toContain("Settings → Connections");
    expect(invalid.message).toMatch(/saved Jira connection/i);
    expect(invalid.message).not.toMatch(/API token|replace/i);

    const reauthorization = new JiraReauthorizationRequiredError();
    expect(reauthorization.message).toContain("Settings → Connections");
    expect(reauthorization.message).not.toContain("Settings → Jira Cloud");

    const invalidPrincipal = new JiraSyncPrincipalError("jira_sync_principal_invalid");
    expect(invalidPrincipal.code).toBe("jira_sync_principal_invalid");
    expect(invalidPrincipal.message).toContain("Settings → Connections");
    expect(invalidPrincipal.message).toMatch(/sync owner must reconnect/i);
    expect(invalidPrincipal.message).not.toMatch(/API token|replace/i);

    const reauthorizationPrincipal = new JiraSyncPrincipalError("jira_sync_principal_reauthorization_required");
    expect(reauthorizationPrincipal.code).toBe("jira_sync_principal_reauthorization_required");
    expect(reauthorizationPrincipal.message).toContain("Settings → Connections");
    expect(reauthorizationPrincipal.message).toMatch(/sync owner must reconnect/i);
  });

  it("distinguishes a missing sync principal from an invalid or reauth-required one by error code", async () => {
    mocks.sqlGet.mockResolvedValueOnce(undefined);
    await expect(resolveJiraSyncPrincipalCredentials("ws-1")).rejects.toMatchObject({
      code: "jira_sync_principal_missing",
    });

    mocks.sqlGet.mockResolvedValueOnce({ ...activeRow, status: "invalid" });
    const invalid = await resolveJiraSyncPrincipalCredentials("ws-1").catch((error) => error as JiraSyncPrincipalError);
    expect(invalid).toBeInstanceOf(JiraSyncPrincipalError);
    expect((invalid as JiraSyncPrincipalError).code).toBe("jira_sync_principal_invalid");

    mocks.sqlGet.mockResolvedValueOnce({ ...oauthRow, status: "reauthorization_required" });
    const reauth = await resolveJiraSyncPrincipalCredentials("ws-1").catch((error) => error as JiraSyncPrincipalError);
    expect(reauth).toBeInstanceOf(JiraSyncPrincipalError);
    expect((reauth as JiraSyncPrincipalError).code).toBe("jira_sync_principal_reauthorization_required");
    // The code must survive the worker's jobs.error_code allowlist.
    expect("jira_sync_principal_reauthorization_required").toMatch(/^(jira_sync_principal_|integration_)[a-z_]{1,80}$/);
  });

  it("resolves an active sync principal with owner/admin gating in SQL", async () => {
    mocks.sqlGet.mockResolvedValueOnce(activeRow);
    await expect(resolveJiraSyncPrincipalCredentials("ws-1")).resolves.toEqual({
      userId: "user-1", kind: "api_token", email: "user@example.test", apiToken: "plain-token", tokenKind: "scoped", cloudId: "cloud-a",
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const [sql] = mocks.sqlGet.mock.calls[0];
    expect(sql).toContain("c.is_sync_principal = true");
    expect(sql).toContain("m.role IN ('owner', 'admin')");
    expect(sql).toContain("w.provider_id = 'jira-cloud'");
  });
});

describe("OAuth access-token supplier", () => {
  const transactionClient = { query: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlGet.mockReset();
    mocks.sqlRun.mockReset().mockResolvedValue(1);
    mocks.withTransaction.mockReset().mockImplementation(async (fn) => fn(transactionClient));
    mocks.refreshTokens.mockReset();
    mocks.encryptSecret.mockReset().mockImplementation((value: string) => ({
      ciphertext: `enc(${value})`, iv: "iv", tag: "tag", keyVersion: 1,
    }));
    mocks.decryptSecret.mockReset().mockImplementation((input: { ciphertext: string }) =>
      input.ciphertext === "enc-access" ? "plain-access" : "plain-refresh");
  });

  async function supplier() {
    mocks.sqlGet.mockResolvedValueOnce(oauthRow);
    const credential = await resolveJiraCredentials({ workspaceId: "ws-1", userId: "user-1" });
    if (credential.kind !== "oauth") throw new Error("expected an oauth credential");
    return credential.getAccessToken;
  }

  it("serves a fresh stored token from the lock-free fast path", async () => {
    const getToken = await supplier();
    mocks.sqlGet.mockResolvedValueOnce(oauthRow); // fast-path read; expiry 11:00 vs now 10:00
    await expect(getToken()).resolves.toEqual({ accessToken: "plain-access", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(mocks.withTransaction).not.toHaveBeenCalled();
    expect(mocks.refreshTokens).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token under the row lock and persists the rotated pair atomically", async () => {
    const getToken = await supplier();
    const expiring = { ...oauthRow, access_expires_at: "2026-08-13T10:00:30.000Z" };
    mocks.sqlGet
      .mockResolvedValueOnce(expiring)   // fast path sees it expiring
      .mockResolvedValueOnce(expiring);  // in-lock re-read
    mocks.refreshTokens.mockResolvedValue({
      accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 3600, scope: "", tokenType: "Bearer",
    });

    await expect(getToken()).resolves.toEqual({ accessToken: "new-access", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(mocks.refreshTokens).toHaveBeenCalledWith("plain-refresh");
    // sqlGet calls: [0] resolve, [1] fast-path read, [2] in-lock read.
    const lockedRead = mocks.sqlGet.mock.calls[2];
    expect(String(lockedRead[0])).toContain("FOR UPDATE");
    const [updateSql, updateParams, updateClient] = mocks.sqlRun.mock.calls[0];
    expect(updateSql).toContain("encrypted_access_token = @encryptedAccessToken");
    expect(updateSql).toContain("encrypted_refresh_token = @encryptedRefreshToken");
    expect(updateSql).toContain("access_expires_at = @accessExpiresAt");
    expect(updateSql).toContain("status = 'active'");
    expect(updateParams).toMatchObject({
      encryptedAccessToken: "enc(new-access)",
      encryptedRefreshToken: "enc(new-refresh)",
      accessExpiresAt: "2026-08-13T11:00:00.000Z",
    });
    expect(JSON.stringify(updateParams)).not.toContain("new-access\"");
    expect(updateClient).toBe(transactionClient);
  });

  it("collapses to the stored token when another flight already rotated it", async () => {
    const getToken = await supplier();
    // This supplier served a token, got a 401, and forces a refresh — but
    // in-lock the row shows a different encrypted credential: another
    // flight rotated meanwhile. Reuse it; never burn a second rotation.
    mocks.sqlGet
      .mockResolvedValueOnce(oauthRow)
      .mockResolvedValueOnce({ ...oauthRow, access_token_iv: "rotated-iv" });
    const rejected = await getToken();
    const reused = await getToken({ forceRefresh: true, rejectedRevision: rejected.revision });
    expect(rejected.accessToken).toBe("plain-access");
    expect(reused.accessToken).toBe("plain-access");
    expect(reused.revision).not.toBe(rejected.revision);
    expect(mocks.refreshTokens).not.toHaveBeenCalled();
  });

  it("force-refreshes when the stored token is the one that just 401ed", async () => {
    const getToken = await supplier();
    mocks.sqlGet
      .mockResolvedValueOnce(oauthRow)
      .mockResolvedValueOnce(oauthRow); // in-lock: same credential requires refresh
    mocks.refreshTokens.mockResolvedValue({
      accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 3600, scope: "", tokenType: "Bearer",
    });
    const rejected = await getToken();
    expect(rejected.accessToken).toBe("plain-access");
    await expect(getToken({ forceRefresh: true, rejectedRevision: rejected.revision })).resolves.toEqual({
      accessToken: "new-access", revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(mocks.refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("flips the row to reauthorization_required on a terminal refresh, keeping flag and ciphertexts", async () => {
    const getToken = await supplier();
    const expiring = { ...oauthRow, access_expires_at: "2026-08-13T10:00:30.000Z" };
    mocks.sqlGet.mockResolvedValueOnce(expiring).mockResolvedValueOnce(expiring);
    mocks.refreshTokens.mockRejectedValue(new AtlassianReauthorizationRequiredError());

    const error = await getToken().catch((caught) => caught as JiraBearerAuthError);
    expect(error).toBeInstanceOf(JiraBearerAuthError);
    expect((error as JiraBearerAuthError).reason).toBe("reauthorization_required");
    const [flipSql] = mocks.sqlRun.mock.calls[0];
    expect(flipSql).toContain("status = 'reauthorization_required'");
    expect(flipSql).toContain("AND status = 'active'");
    expect(flipSql).not.toContain("is_sync_principal");
    expect(flipSql).not.toContain("encrypted_");
  });

  it("leaves the row untouched on a transient refresh failure", async () => {
    const getToken = await supplier();
    const expiring = { ...oauthRow, access_expires_at: "2026-08-13T10:00:30.000Z" };
    mocks.sqlGet.mockResolvedValueOnce(expiring).mockResolvedValueOnce(expiring);
    mocks.refreshTokens.mockRejectedValue(new AtlassianOAuthError("Atlassian authorization is unavailable. Try again later."));

    const error = await getToken().catch((caught) => caught as JiraBearerAuthError);
    expect(error).toBeInstanceOf(JiraBearerAuthError);
    expect((error as JiraBearerAuthError).reason).toBe("unavailable");
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });

  it("fails loudly as transient when the rotation persist matches no row — never silently drops the rotated pair", async () => {
    const getToken = await supplier();
    const expiring = { ...oauthRow, access_expires_at: "2026-08-13T10:00:30.000Z" };
    mocks.sqlGet.mockResolvedValueOnce(expiring).mockResolvedValueOnce(expiring);
    mocks.refreshTokens.mockResolvedValue({
      accessToken: "new-access", refreshToken: "new-refresh", expiresInSeconds: 3600, scope: "", tokenType: "Bearer",
    });
    mocks.sqlRun.mockResolvedValueOnce(0);

    const error = await getToken().catch((caught) => caught as JiraBearerAuthError);
    expect(error).toBeInstanceOf(JiraBearerAuthError);
    expect((error as JiraBearerAuthError).reason).toBe("unavailable");
  });

  it("reports a row that stopped being OAuth (revoked or replaced by a token) as terminal, not retryable-unknown", async () => {
    const getToken = await supplier();
    mocks.sqlGet.mockResolvedValueOnce(undefined);
    const error = await getToken().catch((caught) => caught as JiraBearerAuthError);
    expect(error).toBeInstanceOf(JiraBearerAuthError);
    expect((error as JiraBearerAuthError).reason).toBe("reauthorization_required");
    expect(mocks.refreshTokens).not.toHaveBeenCalled();
  });

  it("reports reauthorization_required without a refresh attempt when the row is already flipped", async () => {
    const getToken = await supplier();
    mocks.sqlGet.mockResolvedValueOnce({ ...oauthRow, status: "reauthorization_required" });
    const error = await getToken().catch((caught) => caught as JiraBearerAuthError);
    expect(error).toBeInstanceOf(JiraBearerAuthError);
    expect((error as JiraBearerAuthError).reason).toBe("reauthorization_required");
    expect(mocks.refreshTokens).not.toHaveBeenCalled();
  });
});

describe("Jira connection lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlGet.mockReset().mockResolvedValue(activeRow);
    mocks.sqlRun.mockReset().mockResolvedValue(1);
    mocks.withTransaction.mockReset().mockImplementation(async (fn) => fn({ query: vi.fn() }));
  });

  async function currentRevision(kind: "api_token" | "oauth") {
    mocks.sqlGet.mockResolvedValue(kind === "api_token" ? activeRow : oauthRow);
    const credential = await resolveJiraCredentials({ workspaceId: "ws-1", userId: "user-1" });
    return credential.kind === "api_token" ? credential.revision : (await credential.getAccessToken()).revision;
  }

  it("marks a connection invalid on use-time 401 while KEEPING the principal flag and token", async () => {
    await markJiraConnectionInvalid("ws-1", "user-1", await currentRevision("api_token"));
    const [sql, params] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("status = @status");
    expect(sql).toContain("AND status = 'active'");
    // invalid is the api_token failure state; the schema rejects it on oauth rows.
    expect(sql).toContain("credential_kind = @credentialKind");
    expect(sql).not.toContain("is_sync_principal");
    expect(sql).not.toContain("encrypted_api_token");
    expect(params).toMatchObject({ id: activeRow.id, credentialKind: "api_token", status: "invalid" });
    expect(mocks.sqlGet.mock.calls.at(-1)).toEqual([
      expect.stringContaining("FOR UPDATE"),
      { workspaceId: "ws-1", userId: "user-1", credentialKind: "api_token" },
      expect.anything(),
    ]);
  });

  it("marks an OAuth connection reauthorization-required, mirroring the invalid lifecycle", async () => {
    await markJiraConnectionReauthorizationRequired("ws-1", "user-1", await currentRevision("oauth"));
    const [sql, params] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("status = @status");
    expect(sql).toContain("credential_kind = @credentialKind");
    expect(sql).toContain("AND status = 'active'");
    expect(sql).not.toContain("is_sync_principal");
    expect(sql).not.toContain("encrypted_");
    expect(params).toMatchObject({ id: oauthRow.id, credentialKind: "oauth", status: "reauthorization_required" });
  });

  it("is idempotent when the connection is already invalid or revoked", async () => {
    mocks.sqlGet.mockResolvedValueOnce(undefined);
    await expect(markJiraConnectionInvalid("ws-1", "user-1", "old-revision")).resolves.toBeUndefined();
    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });

  it.each(["api_token", "oauth"] as const)("the %s HTTP hook invalidates its exact current credential", async (kind) => {
    mocks.sqlGet.mockResolvedValue(kind === "api_token" ? activeRow : oauthRow);
    const credential = await resolveJiraCredentials({ workspaceId: "ws-1", userId: "user-1" });
    const revision = credential.kind === "oauth" ? (await credential.getAccessToken()).revision : undefined;
    jiraOnUnauthorized(credential, "ws-1", "user-1").onUnauthorized!(revision);
    await vi.waitFor(() => expect(mocks.sqlRun).toHaveBeenCalledTimes(1));
    expect(mocks.sqlRun.mock.calls[0][1]).toMatchObject({
      credentialKind: kind, status: kind === "api_token" ? "invalid" : "reauthorization_required",
    });
  });

  it("revokes a connection, clears sync-principal ownership, and genuinely NULLs both kinds' secrets", async () => {
    await revokeJiraConnection({ workspaceId: "ws-1", actorUserId: "user-1" });
    const [sql] = mocks.sqlRun.mock.calls[0];
    expect(sql).toContain("status = 'revoked'");
    expect(sql).toContain("is_sync_principal = false");
    expect(sql).toContain("encrypted_api_token = NULL");
    expect(sql).toContain("encrypted_access_token = NULL");
    expect(sql).toContain("encrypted_refresh_token = NULL");
    expect(sql).toContain("access_expires_at = NULL");
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
