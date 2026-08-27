import { afterAll, beforeAll, expect, it } from "vitest";

import { getPool, resetDatabaseForTests, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import { storeJiraConnection } from "@/modules/auth/jira-connection.service";
import { provisionJiraLogin } from "@/modules/auth/jira-provisioning.service";
import { getWorkspaceMembership } from "@/modules/workspace/workspace-access.service";
import { describeDb } from "@/test/db";

// DB-backed (ADR-9): requires a migrated PostgreSQL via DATABASE_URL.

const SITE_A = "https://itf-jira-boot-a.atlassian.net"; // seeded → adopted by OAuth
const SITE_B = "https://itf-jira-boot-b.atlassian.net"; // unseeded → first-login-wins regression
const SITE_C = "https://itf-jira-boot-c.atlassian.net"; // seeded → concurrent first logins
const SITE_D = "https://itf-jira-boot-d.atlassian.net"; // connected first, seeded afterwards
const RENAME_SIMPLE_OLD = "https://itf-jira-rename-simple-old.atlassian.net";
const RENAME_SIMPLE_NEW = "https://itf-jira-rename-simple-new.atlassian.net";
const RENAME_REPOINT_OLD = "https://itf-jira-rename-repoint-old.atlassian.net";
const RENAME_REPOINT_NEW = "https://itf-jira-rename-repoint-new.atlassian.net";
const RENAME_CONFLICT_OLD = "https://itf-jira-rename-conflict-old.atlassian.net";
const RENAME_CONFLICT_NEW = "https://itf-jira-rename-conflict-new.atlassian.net";
const RENAME_MALFORMED_OLD = "https://itf-jira-rename-malformed-old.atlassian.net";
const RENAME_MALFORMED_NEW = "https://itf-jira-rename-malformed-new.atlassian.net";
const RENAME_COLLISION_OLD = "https://itf-jira-rename-collision-old.atlassian.net";
const RENAME_COLLISION_NEW = "https://itf-jira-rename-collision-new.atlassian.net";
const RENAME_CONCURRENT_OLD = "https://itf-jira-rename-concurrent-old.atlassian.net";
const RENAME_CONCURRENT_NEW = "https://itf-jira-rename-concurrent-new.atlassian.net";
const RENAME_BOOTSTRAP_RACE_OLD = "https://itf-jira-rename-bootstrap-race-old.atlassian.net";
const RENAME_BOOTSTRAP_RACE_NEW = "https://itf-jira-rename-bootstrap-race-new.atlassian.net";
const ORG_M = "https://dev.azure.com/itf-jira-boot-mixed";
const OWNER_A = "jira-owner-a@itf-bootstrap.test";
const VISITOR = "jira-visitor@itf-bootstrap.test";
const RACER_1 = "jira-racer-1@itf-bootstrap.test";
const RACER_2 = "jira-racer-2@itf-bootstrap.test";
const FIRST_D = "jira-first-d@itf-bootstrap.test";
const RENAME_OWNER_A = "owner-a@itf-rename.test";
const RENAME_OWNER_B = "owner-b@itf-rename.test";
const RENAME_VISITOR_A = "visitor-a@itf-rename.test";
const RENAME_VISITOR_B = "visitor-b@itf-rename.test";
const RENAME_EXTRA = "extra@itf-rename.test";
const RENAME_FAILED_LOGIN = "failed-login@itf-rename.test";
const RENAME_RACE_OWNER = "race-owner@itf-rename.test";

const ENV_KEYS = [
  "BOOTSTRAP_OWNER_EMAIL",
  "BOOTSTRAP_OWNER_AZURE_ORG",
  "BOOTSTRAP_AZURE_ORGS",
  "BOOTSTRAP_OWNER_JIRA_SITE",
  "BOOTSTRAP_JIRA_SITES",
  "ATLASSIAN_ALLOWED_CLOUD_IDS",
  "APP_ENCRYPTION_KEY",
] as const;

async function userIdByEmail(email: string): Promise<string | undefined> {
  return (
    await sqlGet<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(email_or_unique_name) = LOWER(@email)`,
      { email },
    )
  )?.id;
}

async function jiraWorkspacesByUrl(siteUrl: string): Promise<Array<{
  id: string;
  name: string;
  provider_site_id: string | null;
  provider_site_name: string | null;
}>> {
  return sqlAll(
    `SELECT id, name, provider_site_id, provider_site_name FROM workspaces
     WHERE provider_id = 'jira-cloud' AND provider_site_url = @siteUrl`,
    { siteUrl },
  );
}

async function jiraWorkspaceByCloudId(cloudId: string): Promise<{
  id: string;
  name: string;
  provider_site_url: string | null;
  status: string;
} | undefined> {
  return sqlGet(
    `SELECT id, name, provider_site_url, status FROM workspaces
     WHERE provider_id = 'jira-cloud' AND provider_site_id = @cloudId`,
    { cloudId },
  );
}

describeDb("Jira site bootstrap seeding & OAuth adoption (DB-backed)", () => {
  let saved: Record<string, string | undefined>;

  async function cleanup() {
    for (const url of [SITE_A, SITE_B, SITE_C, SITE_D]) {
      const rows = await sqlAll<{ id: string }>(
        `SELECT id FROM workspaces WHERE provider_id = 'jira-cloud' AND provider_site_url = @url`,
        { url },
      );
      for (const row of rows) {
        await sqlRun(`DELETE FROM workspace_members WHERE workspace_id = @id`, { id: row.id });
        await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id: row.id });
      }
    }
    const renameRows = await sqlAll<{ id: string }>(
      `SELECT id FROM workspaces
       WHERE provider_id = 'jira-cloud'
         AND (
           provider_site_id LIKE 'cloud-rename-%'
           OR provider_site_url LIKE 'https://itf-jira-rename-%'
           OR LOWER(name) LIKE 'itf-jira-rename-%'
         )`,
    );
    for (const row of renameRows) {
      await sqlRun(`DELETE FROM workspace_members WHERE workspace_id = @id`, { id: row.id });
      await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id: row.id });
    }
    const azure = await sqlGet<{ id: string }>(`SELECT id FROM workspaces WHERE azure_org_url = @url`, { url: ORG_M });
    if (azure) {
      await sqlRun(`DELETE FROM workspace_members WHERE workspace_id = @id`, { id: azure.id });
      await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id: azure.id });
    }
    for (const email of [
      OWNER_A,
      VISITOR,
      RACER_1,
      RACER_2,
      FIRST_D,
      RENAME_OWNER_A,
      RENAME_OWNER_B,
      RENAME_VISITOR_A,
      RENAME_VISITOR_B,
      RENAME_EXTRA,
      RENAME_FAILED_LOGIN,
      RENAME_RACE_OWNER,
    ]) {
      // external_identities cascade with the user row
      await sqlRun(`DELETE FROM users WHERE LOWER(email_or_unique_name) = LOWER(@email)`, { email });
    }
  }

  beforeAll(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.BOOTSTRAP_JIRA_SITES = `${SITE_A}|${OWNER_A}, ${SITE_C}|${OWNER_A}`;
    process.env.ATLASSIAN_ALLOWED_CLOUD_IDS = [
      "cloud-boot-a",
      "cloud-boot-b",
      "cloud-boot-c",
      "cloud-boot-d",
      "cloud-rename-simple",
      "cloud-rename-repoint",
      "cloud-rename-conflict",
      "cloud-rename-malformed",
      "cloud-rename-collision-a",
      "cloud-rename-collision-b",
      "cloud-rename-concurrent",
      "cloud-rename-bootstrap-race",
    ].join(",");
    process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await resetDatabaseForTests();
  });

  it("seeds each configured site once (idempotent) with a pending site id and an owner membership", async () => {
    const first = await ensureBootstrapOwner();
    const second = await ensureBootstrapOwner();
    expect(first).not.toBeNull();
    expect(second).toEqual(first); // deterministic first-entry return, Jira-only deployment

    const workspaces = await jiraWorkspacesByUrl(SITE_A);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].provider_site_id).toBeNull(); // cloudId unknown until first OAuth
    expect(workspaces[0].name).toBe("itf-jira-boot-a");

    const ownerId = await userIdByEmail(OWNER_A);
    expect(ownerId).toBeTruthy();
    expect(first).toEqual({ workspaceId: workspaces[0].id, userId: ownerId });
    expect((await getWorkspaceMembership(ownerId!, workspaces[0].id))?.role).toBe("owner");
  });

  it("adopts the seeded workspace on first OAuth login and joins that user as member", async () => {
    const seeded = (await jiraWorkspacesByUrl(SITE_A))[0];

    const result = await provisionJiraLogin({
      resource: { id: "cloud-boot-a", name: "Boot A", url: `${SITE_A}/`, scopes: [] },
      identity: { accountId: "acc-visitor", displayName: "First Visitor", emailAddress: VISITOR },
    });

    expect(result.workspaceId).toBe(seeded.id); // adopted, not duplicated
    expect(result.role).toBe("member"); // seeded owner keeps ownership

    const workspaces = await jiraWorkspacesByUrl(SITE_A);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].provider_site_id).toBe("cloud-boot-a");
    expect(workspaces[0].provider_site_name).toBe("Boot A");

    const ownerId = await userIdByEmail(OWNER_A);
    expect((await getWorkspaceMembership(ownerId!, seeded.id))?.role).toBe("owner");
  });

  it("links the seeded owner's own OAuth login by case-insensitive email and keeps the owner role", async () => {
    const seeded = (await jiraWorkspacesByUrl(SITE_A))[0];
    const ownerId = await userIdByEmail(OWNER_A);

    const result = await provisionJiraLogin({
      resource: { id: "cloud-boot-a", name: "Boot A", url: SITE_A, scopes: [] },
      identity: { accountId: "acc-owner", displayName: "Seeded Owner", emailAddress: OWNER_A.toUpperCase() },
    });

    expect(result.workspaceId).toBe(seeded.id);
    expect(result.userId).toBe(ownerId);
    expect(result.role).toBe("owner");
  });

  it("keeps first-login-wins ownership for a site that was never seeded", async () => {
    const result = await provisionJiraLogin({
      resource: { id: "cloud-boot-b", name: "Boot B", url: SITE_B, scopes: [] },
      identity: { accountId: "acc-b-first", displayName: "Unseeded First", emailAddress: VISITOR },
    });
    expect(result.role).toBe("owner");
    expect(await jiraWorkspacesByUrl(SITE_B)).toHaveLength(1);
  });

  it("serializes concurrent first logins against one seeded site into a single workspace", async () => {
    const [a, b] = await Promise.all([
      provisionJiraLogin({
        resource: { id: "cloud-boot-c", name: "Boot C", url: SITE_C, scopes: [] },
        identity: { accountId: "acc-race-1", displayName: "Racer One", emailAddress: RACER_1 },
      }),
      provisionJiraLogin({
        resource: { id: "cloud-boot-c", name: "Boot C", url: SITE_C, scopes: [] },
        identity: { accountId: "acc-race-2", displayName: "Racer Two", emailAddress: RACER_2 },
      }),
    ]);

    expect(a.workspaceId).toBe(b.workspaceId);
    expect(a.role).toBe("member");
    expect(b.role).toBe("member");
    expect(await jiraWorkspacesByUrl(SITE_C)).toHaveLength(1);
  });

  it("seeds Azure orgs and Jira sites side by side for a shared owner without cross-contamination", async () => {
    // Case-variant email across providers must resolve to ONE user through the
    // shared case-insensitive bootstrap-user helper (idx_users_email_ci).
    process.env.BOOTSTRAP_AZURE_ORGS = `${ORG_M}|${OWNER_A.toUpperCase()}`;
    try {
      const result = await ensureBootstrapOwner();

      const azure = await sqlGet<{ id: string; provider_site_url: string | null }>(
        `SELECT id, provider_site_url FROM workspaces WHERE azure_org_url = @url`,
        { url: ORG_M },
      );
      expect(azure).toBeTruthy();
      expect(azure!.provider_site_url).toBeNull(); // Azure rows never enter the Jira URL namespace

      const users = await sqlAll<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email_or_unique_name) = LOWER(@email)`,
        { email: OWNER_A },
      );
      expect(users).toHaveLength(1);
      const ownerId = users[0].id;
      expect(result).toEqual({ workspaceId: azure!.id, userId: ownerId }); // Azure entries stay first
      expect((await getWorkspaceMembership(ownerId, azure!.id))?.role).toBe("owner");

      // The already-adopted Jira workspace is untouched (no duplicate, owner intact).
      const jira = await jiraWorkspacesByUrl(SITE_A);
      expect(jira).toHaveLength(1);
      expect((await getWorkspaceMembership(ownerId, jira[0].id))?.role).toBe("owner");
    } finally {
      delete process.env.BOOTSTRAP_AZURE_ORGS;
    }
  });

  it("seeding an already-connected site keeps the first owner's sync principal and still lets the seeded owner connect", async () => {
    // A site connects organically first: its first user becomes owner + sync principal.
    const first = await provisionJiraLogin({
      resource: { id: "cloud-boot-d", name: "Boot D", url: SITE_D, scopes: [] },
      identity: { accountId: "acc-d-first", displayName: "First D", emailAddress: FIRST_D },
    });
    expect(first.role).toBe("owner");
    await storeJiraConnection({
      workspaceId: first.workspaceId,
      userId: first.userId,
      cloudId: "cloud-boot-d",
      accessToken: "first-access",
      refreshToken: "first-refresh",
      expiresInSeconds: 3600,
      scopes: "offline_access",
      isSyncPrincipal: first.role === "owner",
    });

    // The operator then adds the site to BOOTSTRAP_JIRA_SITES with a declared owner.
    const savedSites = process.env.BOOTSTRAP_JIRA_SITES;
    process.env.BOOTSTRAP_JIRA_SITES = `${savedSites}, ${SITE_D}|${OWNER_A}`;
    try {
      await ensureBootstrapOwner();
    } finally {
      process.env.BOOTSTRAP_JIRA_SITES = savedSites;
    }
    expect(await jiraWorkspacesByUrl(SITE_D)).toHaveLength(1); // adopted, not duplicated

    // The seeded owner's own first OAuth login must succeed — their connection
    // yields the sync principal instead of violating its unique index.
    const seededOwner = await provisionJiraLogin({
      resource: { id: "cloud-boot-d", name: "Boot D", url: SITE_D, scopes: [] },
      identity: { accountId: "acc-d-owner", displayName: "Seeded Owner D", emailAddress: OWNER_A },
    });
    expect(seededOwner.workspaceId).toBe(first.workspaceId);
    expect(seededOwner.role).toBe("owner");
    await storeJiraConnection({
      workspaceId: seededOwner.workspaceId,
      userId: seededOwner.userId,
      cloudId: "cloud-boot-d",
      accessToken: "owner-access",
      refreshToken: "owner-refresh",
      expiresInSeconds: 3600,
      scopes: "offline_access",
      isSyncPrincipal: seededOwner.role === "owner",
    });

    const principals = await sqlAll<{ user_id: string; is_sync_principal: boolean }>(
      `SELECT user_id, is_sync_principal FROM jira_connections WHERE workspace_id = @id ORDER BY created_at ASC`,
      { id: first.workspaceId },
    );
    expect(principals).toHaveLength(2);
    expect(principals.find((row) => row.user_id === first.userId)?.is_sync_principal).toBe(true);
    expect(principals.find((row) => row.user_id === seededOwner.userId)?.is_sync_principal).toBe(false);
  });

  it("refreshes a renamed Jira URL in place when no placeholder exists", async () => {
    const first = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-simple",
        name: "ITF Rename Simple Old",
        url: RENAME_SIMPLE_OLD,
        scopes: [],
      },
      identity: {
        accountId: "rename-simple-owner",
        displayName: "Rename Owner A",
        emailAddress: RENAME_OWNER_A,
      },
    });

    const renamed = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-simple",
        name: "ITF Rename Simple New",
        url: RENAME_SIMPLE_NEW,
        scopes: [],
      },
      identity: {
        accountId: "rename-simple-owner",
        displayName: "Rename Owner A",
        emailAddress: RENAME_OWNER_A,
      },
    });

    expect(renamed.workspaceId).toBe(first.workspaceId);
    expect(renamed.role).toBe("owner");
    expect(await jiraWorkspacesByUrl(RENAME_SIMPLE_OLD)).toHaveLength(0);
    expect((await jiraWorkspacesByUrl(RENAME_SIMPLE_NEW))[0]?.id).toBe(first.workspaceId);
    expect((await jiraWorkspaceByCloudId("cloud-rename-simple"))?.name).toBe("ITF Rename Simple New");
  });

  it("re-points a bootstrapped placeholder owner, retires the placeholder, and stays idempotent", async () => {
    const target = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-repoint",
        name: "ITF Rename Repoint Old",
        url: RENAME_REPOINT_OLD,
        scopes: [],
      },
      identity: {
        accountId: "rename-repoint-owner-a",
        displayName: "Rename Owner A",
        emailAddress: RENAME_OWNER_A,
      },
    });

    const savedSites = process.env.BOOTSTRAP_JIRA_SITES;
    process.env.BOOTSTRAP_JIRA_SITES = `${RENAME_REPOINT_NEW}|${RENAME_OWNER_B}`;
    try {
      await ensureBootstrapOwner();
    } finally {
      if (savedSites === undefined) delete process.env.BOOTSTRAP_JIRA_SITES;
      else process.env.BOOTSTRAP_JIRA_SITES = savedSites;
    }
    const placeholder = (await jiraWorkspacesByUrl(RENAME_REPOINT_NEW))[0];
    const placeholderOwner = await sqlGet<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM workspace_members
       WHERE workspace_id = @workspaceId AND role = 'owner' AND status = 'active'`,
      { workspaceId: placeholder.id },
    );

    const renamed = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-repoint",
        name: "ITF Rename Repoint New",
        url: RENAME_REPOINT_NEW,
        scopes: [],
      },
      identity: {
        accountId: "rename-repoint-visitor",
        displayName: "Rename Visitor A",
        emailAddress: RENAME_VISITOR_A,
      },
    });
    const repeated = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-repoint",
        name: "ITF Rename Repoint New",
        url: RENAME_REPOINT_NEW,
        scopes: [],
      },
      identity: {
        accountId: "rename-repoint-visitor",
        displayName: "Rename Visitor A",
        emailAddress: RENAME_VISITOR_A,
      },
    });

    expect(renamed.workspaceId).toBe(target.workspaceId);
    expect(renamed.role).toBe("member");
    expect(repeated).toEqual(renamed);
    expect(await jiraWorkspacesByUrl(RENAME_REPOINT_OLD)).toHaveLength(0);
    expect((await jiraWorkspacesByUrl(RENAME_REPOINT_NEW))[0]?.id).toBe(target.workspaceId);
    expect(await sqlGet(
      `SELECT id FROM workspaces
       WHERE id = @id AND status = 'inactive' AND provider_site_url IS NULL`,
      { id: placeholder.id },
    )).toBeTruthy();
    expect(await sqlGet(
      `SELECT id FROM workspace_members
       WHERE id = @id AND workspace_id = @workspaceId AND role = 'owner' AND status = 'active'`,
      { id: placeholderOwner!.id, workspaceId: target.workspaceId },
    )).toBeTruthy();
  });

  it("upgrades the placeholder owner when that user already belongs to the target", async () => {
    const target = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-conflict",
        name: "ITF Rename Conflict Old",
        url: RENAME_CONFLICT_OLD,
        scopes: [],
      },
      identity: {
        accountId: "rename-conflict-owner-a",
        displayName: "Rename Owner A",
        emailAddress: RENAME_OWNER_A,
      },
    });
    const existingMember = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-conflict",
        name: "ITF Rename Conflict Old",
        url: RENAME_CONFLICT_OLD,
        scopes: [],
      },
      identity: {
        accountId: "rename-conflict-owner-b",
        displayName: "Rename Owner B",
        emailAddress: RENAME_OWNER_B,
      },
    });
    expect(existingMember.role).toBe("member");

    const savedSites = process.env.BOOTSTRAP_JIRA_SITES;
    process.env.BOOTSTRAP_JIRA_SITES = `${RENAME_CONFLICT_NEW}|${RENAME_OWNER_B}`;
    try {
      await ensureBootstrapOwner();
    } finally {
      if (savedSites === undefined) delete process.env.BOOTSTRAP_JIRA_SITES;
      else process.env.BOOTSTRAP_JIRA_SITES = savedSites;
    }
    const placeholder = (await jiraWorkspacesByUrl(RENAME_CONFLICT_NEW))[0];
    const sourceMembership = await sqlGet<{ id: string }>(
      `SELECT id FROM workspace_members WHERE workspace_id = @workspaceId AND user_id = @userId`,
      { workspaceId: placeholder.id, userId: existingMember.userId },
    );

    const renamed = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-conflict",
        name: "ITF Rename Conflict New",
        url: RENAME_CONFLICT_NEW,
        scopes: [],
      },
      identity: {
        accountId: "rename-conflict-owner-b",
        displayName: "Rename Owner B",
        emailAddress: RENAME_OWNER_B,
      },
    });

    expect(renamed.workspaceId).toBe(target.workspaceId);
    expect(renamed.role).toBe("owner");
    expect((await getWorkspaceMembership(existingMember.userId, target.workspaceId))?.role).toBe("owner");
    expect(await sqlGet(
      `SELECT id FROM workspace_members WHERE id = @id AND status = 'inactive'`,
      { id: sourceMembership!.id },
    )).toBeTruthy();
  });

  it("rejects a malformed placeholder and rolls every workspace mutation back", async () => {
    const target = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-malformed",
        name: "ITF Rename Malformed Old",
        url: RENAME_MALFORMED_OLD,
        scopes: [],
      },
      identity: {
        accountId: "rename-malformed-owner-a",
        displayName: "Rename Owner A",
        emailAddress: RENAME_OWNER_A,
      },
    });
    const savedSites = process.env.BOOTSTRAP_JIRA_SITES;
    process.env.BOOTSTRAP_JIRA_SITES = `${RENAME_MALFORMED_NEW}|${RENAME_OWNER_B}`;
    try {
      await ensureBootstrapOwner();
    } finally {
      if (savedSites === undefined) delete process.env.BOOTSTRAP_JIRA_SITES;
      else process.env.BOOTSTRAP_JIRA_SITES = savedSites;
    }
    const placeholder = (await jiraWorkspacesByUrl(RENAME_MALFORMED_NEW))[0];
    await sqlRun(
      `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
       VALUES ('user_rename_extra', 'Rename Extra', @email, 'active', @now)`,
      { email: RENAME_EXTRA, now: new Date().toISOString() },
    );
    await sqlRun(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES ('wm_rename_extra', @workspaceId, 'user_rename_extra', 'member', 'active', @now, @now)`,
      { workspaceId: placeholder.id, now: new Date().toISOString() },
    );

    await expect(provisionJiraLogin({
      resource: {
        id: "cloud-rename-malformed",
        name: "ITF Rename Malformed New",
        url: RENAME_MALFORMED_NEW,
        scopes: [],
      },
      identity: {
        accountId: "rename-malformed-failed",
        displayName: "Failed Login",
        emailAddress: RENAME_FAILED_LOGIN,
      },
    })).rejects.toThrow("placeholder");

    expect((await jiraWorkspaceByCloudId("cloud-rename-malformed"))?.provider_site_url)
      .toBe(RENAME_MALFORMED_OLD);
    expect((await jiraWorkspacesByUrl(RENAME_MALFORMED_NEW))[0]?.id).toBe(placeholder.id);
    expect((await jiraWorkspaceByCloudId("cloud-rename-malformed"))?.id).toBe(target.workspaceId);
    expect(await userIdByEmail(RENAME_FAILED_LOGIN)).toBeUndefined();
  });

  it("never merges two workspaces that already have different cloud IDs", async () => {
    const targetA = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-collision-a",
        name: "ITF Rename Collision A",
        url: RENAME_COLLISION_OLD,
        scopes: [],
      },
      identity: {
        accountId: "rename-collision-owner-a",
        displayName: "Rename Owner A",
        emailAddress: RENAME_OWNER_A,
      },
    });
    const targetB = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-collision-b",
        name: "ITF Rename Collision B",
        url: RENAME_COLLISION_NEW,
        scopes: [],
      },
      identity: {
        accountId: "rename-collision-owner-b",
        displayName: "Rename Owner B",
        emailAddress: RENAME_OWNER_B,
      },
    });

    await expect(provisionJiraLogin({
      resource: {
        id: "cloud-rename-collision-a",
        name: "ITF Rename Collision New",
        url: RENAME_COLLISION_NEW,
        scopes: [],
      },
      identity: {
        accountId: "rename-collision-failed",
        displayName: "Failed Login",
        emailAddress: RENAME_FAILED_LOGIN,
      },
    })).rejects.toThrow("collision");

    expect((await jiraWorkspaceByCloudId("cloud-rename-collision-a"))?.id).toBe(targetA.workspaceId);
    expect((await jiraWorkspaceByCloudId("cloud-rename-collision-a"))?.provider_site_url)
      .toBe(RENAME_COLLISION_OLD);
    expect((await jiraWorkspaceByCloudId("cloud-rename-collision-b"))?.id).toBe(targetB.workspaceId);
    expect((await jiraWorkspaceByCloudId("cloud-rename-collision-b"))?.provider_site_url)
      .toBe(RENAME_COLLISION_NEW);
  });

  it("serializes concurrent rename reconciliation without duplicating the owner transfer", async () => {
    const target = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-concurrent",
        name: "ITF Rename Concurrent Old",
        url: RENAME_CONCURRENT_OLD,
        scopes: [],
      },
      identity: {
        accountId: "rename-concurrent-owner-a",
        displayName: "Rename Owner A",
        emailAddress: RENAME_OWNER_A,
      },
    });
    const savedSites = process.env.BOOTSTRAP_JIRA_SITES;
    process.env.BOOTSTRAP_JIRA_SITES = `${RENAME_CONCURRENT_NEW}|${RENAME_OWNER_B}`;
    try {
      await ensureBootstrapOwner();
    } finally {
      if (savedSites === undefined) delete process.env.BOOTSTRAP_JIRA_SITES;
      else process.env.BOOTSTRAP_JIRA_SITES = savedSites;
    }
    const placeholder = (await jiraWorkspacesByUrl(RENAME_CONCURRENT_NEW))[0];
    const ownerB = await userIdByEmail(RENAME_OWNER_B);

    const [a, b] = await Promise.all([
      provisionJiraLogin({
        resource: {
          id: "cloud-rename-concurrent",
          name: "ITF Rename Concurrent New",
          url: RENAME_CONCURRENT_NEW,
          scopes: [],
        },
        identity: {
          accountId: "rename-concurrent-visitor-a",
          displayName: "Rename Visitor A",
          emailAddress: RENAME_VISITOR_A,
        },
      }),
      provisionJiraLogin({
        resource: {
          id: "cloud-rename-concurrent",
          name: "ITF Rename Concurrent New",
          url: RENAME_CONCURRENT_NEW,
          scopes: [],
        },
        identity: {
          accountId: "rename-concurrent-visitor-b",
          displayName: "Rename Visitor B",
          emailAddress: RENAME_VISITOR_B,
        },
      }),
    ]);

    expect(a.workspaceId).toBe(target.workspaceId);
    expect(b.workspaceId).toBe(target.workspaceId);
    expect(a.role).toBe("member");
    expect(b.role).toBe("member");
    expect((await getWorkspaceMembership(ownerB!, target.workspaceId))?.role).toBe("owner");
    expect(await sqlGet(
      `SELECT id FROM workspaces WHERE id = @id AND status = 'inactive' AND provider_site_url IS NULL`,
      { id: placeholder.id },
    )).toBeTruthy();
    const ownerMemberships = await sqlAll<{ id: string }>(
      `SELECT id FROM workspace_members
       WHERE user_id = @userId AND workspace_id = @workspaceId AND role = 'owner' AND status = 'active'`,
      { userId: ownerB, workspaceId: target.workspaceId },
    );
    expect(ownerMemberships).toHaveLength(1);
  });

  it("does not resurrect a placeholder membership when bootstrap cached it before reconciliation", async () => {
    const target = await provisionJiraLogin({
      resource: {
        id: "cloud-rename-bootstrap-race",
        name: "ITF Rename Bootstrap Race Old",
        url: RENAME_BOOTSTRAP_RACE_OLD,
        scopes: [],
      },
      identity: {
        accountId: "rename-bootstrap-race-owner-a",
        displayName: "Rename Owner A",
        emailAddress: RENAME_OWNER_A,
      },
    });
    const initialSites = process.env.BOOTSTRAP_JIRA_SITES;
    process.env.BOOTSTRAP_JIRA_SITES = `${RENAME_BOOTSTRAP_RACE_NEW}|${RENAME_OWNER_B}`;
    try {
      await ensureBootstrapOwner();
    } finally {
      if (initialSites === undefined) delete process.env.BOOTSTRAP_JIRA_SITES;
      else process.env.BOOTSTRAP_JIRA_SITES = initialSites;
    }
    const placeholder = (await jiraWorkspacesByUrl(RENAME_BOOTSTRAP_RACE_NEW))[0];
    const locker = await getPool().connect();
    let lockOpen = false;
    const savedSites = process.env.BOOTSTRAP_JIRA_SITES;
    try {
      await locker.query("BEGIN");
      lockOpen = true;
      await locker.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [placeholder.id]);

      const renamePromise = provisionJiraLogin({
        resource: {
          id: "cloud-rename-bootstrap-race",
          name: "ITF Rename Bootstrap Race New",
          url: RENAME_BOOTSTRAP_RACE_NEW,
          scopes: [],
        },
        identity: {
          accountId: "rename-bootstrap-race-visitor",
          displayName: "Rename Visitor A",
          emailAddress: RENAME_VISITOR_A,
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 30));

      process.env.BOOTSTRAP_JIRA_SITES = `${RENAME_BOOTSTRAP_RACE_NEW}|${RENAME_RACE_OWNER}`;
      let bootstrapSettled = false;
      const bootstrapPromise = ensureBootstrapOwner().finally(() => {
        bootstrapSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(bootstrapSettled).toBe(false);

      await locker.query("COMMIT");
      lockOpen = false;
      const [renamed, bootstrapped] = await Promise.all([renamePromise, bootstrapPromise]);

      expect(renamed.workspaceId).toBe(target.workspaceId);
      expect(bootstrapped?.workspaceId).toBe(target.workspaceId);
      expect(await sqlAll(
        `SELECT id FROM workspace_members WHERE workspace_id = @workspaceId AND status = 'active'`,
        { workspaceId: placeholder.id },
      )).toHaveLength(0);
      const raceOwnerId = await userIdByEmail(RENAME_RACE_OWNER);
      expect((await getWorkspaceMembership(raceOwnerId!, target.workspaceId))?.role).toBe("owner");
    } finally {
      if (lockOpen) await locker.query("ROLLBACK");
      locker.release();
      if (savedSites === undefined) delete process.env.BOOTSTRAP_JIRA_SITES;
      else process.env.BOOTSTRAP_JIRA_SITES = savedSites;
    }
  });
});
