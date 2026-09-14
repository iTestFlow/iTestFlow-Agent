import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createId, nowIso, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { storeJiraConnection } from "@/modules/auth/jira-connection.service";
import { cleanupFixtures, describeDb, seedMembership, seedUser, uniqueTestId } from "@/test/db";
import {
  getUserCredentialStatus,
  isCredentialStale,
  markUserAzurePatExpired,
  resolveUserAzurePat,
  resolveUserLlmConfig,
  saveUserLlmSettings,
  storeUserAzurePat,
  storeUserLlmApiKey,
} from "@/modules/credentials/credential.service";

const WS_URL = "https://dev.azure.com/cred-test-org";

const JIRA_WORKSPACE_ID = uniqueTestId("ws_jira_credential_status");
const JIRA_USER_ID = uniqueTestId("user_jira_credential_status");
const JIRA_CLOUD_ID = uniqueTestId("cloud_jira_credential_status");
const JIRA_SITE_URL = `https://${JIRA_WORKSPACE_ID.replaceAll("_", "-")}.atlassian.net`;
const JIRA_USER_EMAIL = `${JIRA_USER_ID}@itestflow.test`;
const STALE_JIRA_VALIDATED_AT = "2000-01-01T00:00:00.000Z";

const JIRA_POLICY_ENV_KEYS = [
  "BOOTSTRAP_ENABLED_PROVIDERS",
  "BOOTSTRAP_OWNER_EMAIL",
  "BOOTSTRAP_OWNER_AZURE_ORG",
  "BOOTSTRAP_AZURE_ORGS",
  "BOOTSTRAP_OWNER_JIRA_SITE",
  "BOOTSTRAP_JIRA_SITES",
  "JIRA_LOGIN_METHODS",
  "ATLASSIAN_OAUTH_CLIENT_ID",
  "ATLASSIAN_OAUTH_CLIENT_SECRET",
  "ATLASSIAN_OAUTH_REDIRECT_URI",
] as const;

describe("isCredentialStale (pure)", () => {
  const now = "2026-06-22T00:00:00.000Z";

  it("treats a missing timestamp as not stale", () => {
    expect(isCredentialStale(null, now, 60)).toBe(false);
    expect(isCredentialStale(undefined, now, 60)).toBe(false);
  });

  it("is false for a freshly validated credential", () => {
    expect(isCredentialStale("2026-06-21T00:00:00.000Z", now, 60)).toBe(false);
  });

  it("is false at the threshold and true beyond it", () => {
    expect(isCredentialStale("2026-04-23T00:00:00.000Z", now, 60)).toBe(false); // exactly 60 days
    expect(isCredentialStale("2026-04-13T00:00:00.000Z", now, 60)).toBe(true); // ~70 days
  });

  it("guards against unparseable input", () => {
    expect(isCredentialStale("not-a-date", now, 60)).toBe(false);
  });
});

// DB-backed integration coverage; requires migrated PostgreSQL via DATABASE_URL.

describeDb("credential service (DB-backed)", () => {
  const workspaceId = createId("ws");
  const userId = createId("user");
  const originalEncryptionKey = process.env.APP_ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const now = nowIso();
    await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @u`, { u: WS_URL });
    await sqlRun(
      `INSERT INTO workspaces (id, name, azure_org_name, azure_org_url, status, created_at, updated_at)
       VALUES (@id, 'Cred Test', 'cred-test-org', @u, 'active', @now, @now)`,
      { id: workspaceId, u: WS_URL, now },
    );
    await sqlRun(
      `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
       VALUES (@id, 'Cred User', @email, 'active', @now)`,
      { id: userId, email: `${userId}@cred-test`, now },
    );
  });

  afterAll(async () => {
    try {
      await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @u`, { u: WS_URL });
      await sqlRun(`DELETE FROM users WHERE id = @id`, { id: userId });
      await resetDatabaseForTests();
    } finally {
      if (originalEncryptionKey === undefined) {
        delete process.env.APP_ENCRYPTION_KEY;
      } else {
        process.env.APP_ENCRYPTION_KEY = originalEncryptionKey;
      }
    }
  });

  it("stores and resolves an encrypted Azure PAT", async () => {
    await storeUserAzurePat({ workspaceId, userId, pat: "pat-secret-9999" });
    expect(await resolveUserAzurePat(workspaceId, userId)).toBe("pat-secret-9999");
  });

  it("stores an LLM key + settings and resolves a usable config", async () => {
    await storeUserLlmApiKey({ workspaceId, userId, provider: "openai", apiKey: "sk-abc-7777" });
    await saveUserLlmSettings({ workspaceId, userId, provider: "openai", model: "gpt-x", isDefault: true });
    expect(await resolveUserLlmConfig(workspaceId, userId)).toMatchObject({
      provider: "openai",
      model: "gpt-x",
      apiKey: "sk-abc-7777",
    });
  });

  it("exposes only masked status, never raw secrets", async () => {
    const status = await getUserCredentialStatus(workspaceId, userId);
    expect(status.azurePat.status).toBe("configured");
    expect(status.azurePat.maskedPreview).toBe("••••9999");
    expect(status.llm.maskedPreview).toBe("••••7777");
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("pat-secret");
    expect(serialized).not.toContain("sk-abc");
  });

  it("flips the PAT to expired on use-time rejection, idempotently", async () => {
    await markUserAzurePatExpired(workspaceId, userId);
    await markUserAzurePatExpired(workspaceId, userId); // idempotent
    expect((await getUserCredentialStatus(workspaceId, userId)).azurePat.status).toBe("expired");
  });
});

describeDb("Jira credential staleness policy (DB-backed)", () => {
  const savedEncryptionKey = process.env.APP_ENCRYPTION_KEY;
  const savedPolicyEnv = new Map(JIRA_POLICY_ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeAll(async () => {
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 31).toString("base64");
    process.env.BOOTSTRAP_ENABLED_PROVIDERS = "jira-cloud";
    process.env.BOOTSTRAP_OWNER_EMAIL = JIRA_USER_EMAIL;
    delete process.env.BOOTSTRAP_OWNER_AZURE_ORG;
    delete process.env.BOOTSTRAP_AZURE_ORGS;
    delete process.env.BOOTSTRAP_OWNER_JIRA_SITE;
    process.env.BOOTSTRAP_JIRA_SITES = `${JIRA_SITE_URL}|${JIRA_USER_EMAIL}`;
    process.env.JIRA_LOGIN_METHODS = "api_token";
    process.env.ATLASSIAN_OAUTH_CLIENT_ID = "credential-policy-client";
    process.env.ATLASSIAN_OAUTH_CLIENT_SECRET = "credential-policy-secret";
    process.env.ATLASSIAN_OAUTH_REDIRECT_URI = "https://example.test/api/auth/jira/callback";

    const now = nowIso();
    await sqlRun(
      `INSERT INTO workspaces (
         id, name, azure_org_name, azure_org_url, provider_id,
         provider_site_id, provider_site_name, provider_site_url, status, created_at, updated_at
       ) VALUES (
         @id, 'Jira credential status', NULL, NULL, 'jira-cloud',
         @cloudId, 'Jira credential status', @siteUrl, 'active', @now, @now
       )`,
      { id: JIRA_WORKSPACE_ID, cloudId: JIRA_CLOUD_ID, siteUrl: JIRA_SITE_URL, now },
    );
    await seedUser({ id: JIRA_USER_ID, email: JIRA_USER_EMAIL });
    await seedMembership({ workspaceId: JIRA_WORKSPACE_ID, userId: JIRA_USER_ID, role: "owner" });
  });

  afterAll(async () => {
    try {
      await sqlRun(`DELETE FROM jira_connections WHERE workspace_id = @workspaceId`, {
        workspaceId: JIRA_WORKSPACE_ID,
      });
      await cleanupFixtures({ workspaceIds: [JIRA_WORKSPACE_ID], userIds: [JIRA_USER_ID] });
      await resetDatabaseForTests();
    } finally {
      if (savedEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
      else process.env.APP_ENCRYPTION_KEY = savedEncryptionKey;
      for (const [key, value] of savedPolicyEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  beforeEach(async () => {
    process.env.JIRA_LOGIN_METHODS = "api_token";
    await storeJiraConnection({
      workspaceId: JIRA_WORKSPACE_ID,
      userId: JIRA_USER_ID,
      cloudId: JIRA_CLOUD_ID,
      email: JIRA_USER_EMAIL,
      apiToken: "jira-credential-status-token",
      tokenKind: "scoped",
      isSyncPrincipal: true,
    });
    await sqlRun(
      `UPDATE jira_connections SET last_validated_at = @staleAt
       WHERE workspace_id = @workspaceId AND user_id = @userId`,
      { staleAt: STALE_JIRA_VALIDATED_AT, workspaceId: JIRA_WORKSPACE_ID, userId: JIRA_USER_ID },
    );
  });

  it("reports an old active API token as stale when API-token recovery is enabled", async () => {
    expect((await getUserCredentialStatus(JIRA_WORKSPACE_ID, JIRA_USER_ID, ["api_token"])).jira.isStale).toBe(true);
    expect((await getUserCredentialStatus(JIRA_WORKSPACE_ID, JIRA_USER_ID, ["oauth", "api_token"])).jira.isStale).toBe(true);
  });

  it("suppresses an old API-token warning when API-token recovery is unavailable", async () => {
    expect((await getUserCredentialStatus(JIRA_WORKSPACE_ID, JIRA_USER_ID, ["oauth"])).jira.isStale).toBe(false);
    expect((await getUserCredentialStatus(JIRA_WORKSPACE_ID, JIRA_USER_ID, [])).jira.isStale).toBe(false);
  });

  it("never reports an old OAuth connection as an API-token staleness warning", async () => {
    await storeJiraConnection({
      workspaceId: JIRA_WORKSPACE_ID,
      userId: JIRA_USER_ID,
      cloudId: JIRA_CLOUD_ID,
      email: JIRA_USER_EMAIL,
      credentialKind: "oauth",
      accessToken: "jira-credential-status-access",
      refreshToken: "jira-credential-status-refresh",
      expiresInSeconds: 3600,
      isSyncPrincipal: true,
    });
    await sqlRun(
      `UPDATE jira_connections SET last_validated_at = @staleAt
       WHERE workspace_id = @workspaceId AND user_id = @userId`,
      { staleAt: STALE_JIRA_VALIDATED_AT, workspaceId: JIRA_WORKSPACE_ID, userId: JIRA_USER_ID },
    );

    expect((await getUserCredentialStatus(JIRA_WORKSPACE_ID, JIRA_USER_ID, ["api_token", "oauth"])).jira.isStale).toBe(false);
  });

  it("resolves the pinned OAuth-only policy when no method snapshot is provided", async () => {
    process.env.JIRA_LOGIN_METHODS = "oauth";
    expect((await getUserCredentialStatus(JIRA_WORKSPACE_ID, JIRA_USER_ID)).jira.isStale).toBe(false);
  });
});
