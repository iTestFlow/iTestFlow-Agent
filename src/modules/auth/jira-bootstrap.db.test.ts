import { afterAll, beforeAll, expect, it } from "vitest";

import { resetDatabaseForTests, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import { provisionJiraLogin } from "@/modules/auth/jira-provisioning.service";
import { getWorkspaceMembership } from "@/modules/workspace/workspace-access.service";
import { describeDb } from "@/test/db";

// DB-backed (ADR-9): requires a migrated PostgreSQL via DATABASE_URL.

const SITE_A = "https://itf-jira-boot-a.atlassian.net"; // seeded → adopted by OAuth
const SITE_B = "https://itf-jira-boot-b.atlassian.net"; // unseeded → first-login-wins regression
const SITE_C = "https://itf-jira-boot-c.atlassian.net"; // seeded → concurrent first logins
const ORG_M = "https://dev.azure.com/itf-jira-boot-mixed";
const OWNER_A = "jira-owner-a@itf-bootstrap.test";
const VISITOR = "jira-visitor@itf-bootstrap.test";
const RACER_1 = "jira-racer-1@itf-bootstrap.test";
const RACER_2 = "jira-racer-2@itf-bootstrap.test";

const ENV_KEYS = [
  "BOOTSTRAP_OWNER_EMAIL",
  "BOOTSTRAP_OWNER_AZURE_ORG",
  "BOOTSTRAP_AZURE_ORGS",
  "BOOTSTRAP_OWNER_JIRA_SITE",
  "BOOTSTRAP_JIRA_SITES",
  "ATLASSIAN_ALLOWED_CLOUD_IDS",
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

describeDb("Jira site bootstrap seeding & OAuth adoption (DB-backed)", () => {
  let saved: Record<string, string | undefined>;

  async function cleanup() {
    for (const url of [SITE_A, SITE_B, SITE_C]) {
      const rows = await sqlAll<{ id: string }>(
        `SELECT id FROM workspaces WHERE provider_id = 'jira-cloud' AND provider_site_url = @url`,
        { url },
      );
      for (const row of rows) {
        await sqlRun(`DELETE FROM workspace_members WHERE workspace_id = @id`, { id: row.id });
        await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id: row.id });
      }
    }
    const azure = await sqlGet<{ id: string }>(`SELECT id FROM workspaces WHERE azure_org_url = @url`, { url: ORG_M });
    if (azure) {
      await sqlRun(`DELETE FROM workspace_members WHERE workspace_id = @id`, { id: azure.id });
      await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id: azure.id });
    }
    for (const email of [OWNER_A, VISITOR, RACER_1, RACER_2]) {
      // external_identities cascade with the user row
      await sqlRun(`DELETE FROM users WHERE LOWER(email_or_unique_name) = LOWER(@email)`, { email });
    }
  }

  beforeAll(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.BOOTSTRAP_JIRA_SITES = `${SITE_A}|${OWNER_A}, ${SITE_C}|${OWNER_A}`;
    process.env.ATLASSIAN_ALLOWED_CLOUD_IDS = "cloud-boot-a,cloud-boot-b,cloud-boot-c";
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
    process.env.BOOTSTRAP_AZURE_ORGS = `${ORG_M}|${OWNER_A}`;
    try {
      const result = await ensureBootstrapOwner();

      const azure = await sqlGet<{ id: string; provider_site_url: string | null }>(
        `SELECT id, provider_site_url FROM workspaces WHERE azure_org_url = @url`,
        { url: ORG_M },
      );
      expect(azure).toBeTruthy();
      expect(azure!.provider_site_url).toBeNull(); // Azure rows never enter the Jira URL namespace

      const ownerId = await userIdByEmail(OWNER_A);
      expect(result).toEqual({ workspaceId: azure!.id, userId: ownerId }); // Azure entries stay first
      expect((await getWorkspaceMembership(ownerId!, azure!.id))?.role).toBe("owner");

      // The already-adopted Jira workspace is untouched (no duplicate, owner intact).
      const jira = await jiraWorkspacesByUrl(SITE_A);
      expect(jira).toHaveLength(1);
      expect((await getWorkspaceMembership(ownerId!, jira[0].id))?.role).toBe("owner");
    } finally {
      delete process.env.BOOTSTRAP_AZURE_ORGS;
    }
  });
});
