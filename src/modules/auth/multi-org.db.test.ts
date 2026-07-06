import { afterAll, beforeAll, expect, it } from "vitest";

import { resetDatabaseForTests, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import { persistSession, resolveSessionToken } from "@/modules/auth/session.service";
import { getWorkspaceMembership } from "@/modules/workspace/workspace-access.service";
import {
  findWorkspaceByAzureOrgUrl,
  getPrimaryWorkspaceForUser,
  resolveActiveWorkspaceForUser,
  setWorkspaceStatusByOrgUrl,
} from "@/modules/workspace/workspace.service";
import { describeDb, seedMembership, seedUser, seedWorkspace } from "@/test/db";

// DB-backed (ADR-9): requires a migrated PostgreSQL via DATABASE_URL.

const ORG_A = "https://dev.azure.com/itf-multiorg-a";
const ORG_B = "https://dev.azure.com/itf-multiorg-b";
const OWNER_A = "owner-a@itf-multiorg.test";
const OWNER_B = "owner-b@itf-multiorg.test";

async function userIdByEmail(email: string): Promise<string | undefined> {
  return (await sqlGet<{ id: string }>(`SELECT id FROM users WHERE email_or_unique_name = @email`, { email }))?.id;
}
async function workspaceIdByUrl(url: string): Promise<string | undefined> {
  return (await sqlGet<{ id: string }>(`SELECT id FROM workspaces WHERE azure_org_url = @url`, { url }))?.id;
}

describeDb("multi-org bootstrap & active-workspace resolution (DB-backed)", () => {
  const savedOrgs = process.env.BOOTSTRAP_AZURE_ORGS;
  const savedEmail = process.env.BOOTSTRAP_OWNER_EMAIL;
  const savedLegacyOrg = process.env.BOOTSTRAP_OWNER_AZURE_ORG;

  async function cleanup() {
    for (const url of [ORG_A, ORG_B]) await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url });
    for (const email of [OWNER_A, OWNER_B]) await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email });
  }

  beforeAll(async () => {
    delete process.env.BOOTSTRAP_OWNER_EMAIL;
    delete process.env.BOOTSTRAP_OWNER_AZURE_ORG;
    process.env.BOOTSTRAP_AZURE_ORGS = `${ORG_A}|${OWNER_A}, ${ORG_B}|${OWNER_B}`;
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    if (savedOrgs === undefined) delete process.env.BOOTSTRAP_AZURE_ORGS;
    else process.env.BOOTSTRAP_AZURE_ORGS = savedOrgs;
    if (savedEmail === undefined) delete process.env.BOOTSTRAP_OWNER_EMAIL;
    else process.env.BOOTSTRAP_OWNER_EMAIL = savedEmail;
    if (savedLegacyOrg === undefined) delete process.env.BOOTSTRAP_OWNER_AZURE_ORG;
    else process.env.BOOTSTRAP_OWNER_AZURE_ORG = savedLegacyOrg;
    await resetDatabaseForTests();
  });

  it("seeds one owner per org, isolated, and is idempotent", async () => {
    const first = await ensureBootstrapOwner();
    const second = await ensureBootstrapOwner();
    expect(first).not.toBeNull();
    expect(second).toEqual(first); // deterministic first-entry return

    const wsA = await workspaceIdByUrl(ORG_A);
    const wsB = await workspaceIdByUrl(ORG_B);
    const userA = await userIdByEmail(OWNER_A);
    const userB = await userIdByEmail(OWNER_B);
    expect(wsA && wsB && userA && userB).toBeTruthy();

    // Return value is the first entry (org A + its owner).
    expect(first).toEqual({ workspaceId: wsA, userId: userA });

    // Each owner owns ONLY their org; neither is a member of the other.
    expect((await getWorkspaceMembership(userA!, wsA!))?.role).toBe("owner");
    expect(await getWorkspaceMembership(userA!, wsB!)).toBeNull();
    expect((await getWorkspaceMembership(userB!, wsB!))?.role).toBe("owner");
    expect(await getWorkspaceMembership(userB!, wsA!)).toBeNull();
  });

  it("resolveActiveWorkspaceForUser prefers the selected org but re-checks membership", async () => {
    const userId = "user_mo_resolver";
    const wsOld = "ws_mo_old";
    const wsNew = "ws_mo_new";
    const wsInactive = "ws_mo_inactive";
    const wsForeign = "ws_mo_foreign";

    await seedWorkspace({ id: wsOld, orgUrl: "https://dev.azure.com/itf-mo-old" });
    await seedWorkspace({ id: wsNew, orgUrl: "https://dev.azure.com/itf-mo-new" });
    await seedWorkspace({ id: wsInactive, orgUrl: "https://dev.azure.com/itf-mo-inactive" });
    await seedWorkspace({ id: wsForeign, orgUrl: "https://dev.azure.com/itf-mo-foreign" });
    await sqlRun(`UPDATE workspaces SET status = 'inactive' WHERE id = @id`, { id: wsInactive });
    await seedUser({ id: userId, email: "mo-resolver@itf-multiorg.test" });

    // Memberships with explicit, ordered created_at so "oldest" is deterministic.
    await sqlRun(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (@id, @ws, @user, 'member', 'active', @created, @created)`,
      { id: "wm_mo_old", ws: wsOld, user: userId, created: "2020-01-01T00:00:00.000Z" },
    );
    await sqlRun(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (@id, @ws, @user, 'member', 'active', @created, @created)`,
      { id: "wm_mo_new", ws: wsNew, user: userId, created: "2020-06-01T00:00:00.000Z" },
    );
    await seedMembership({ workspaceId: wsInactive, userId, role: "member" });

    try {
      // Selected org → that org.
      expect((await resolveActiveWorkspaceForUser(userId, wsNew))?.id).toBe(wsNew);
      // No selection → oldest membership.
      expect((await resolveActiveWorkspaceForUser(userId, null))?.id).toBe(wsOld);
      // Selected org the user is NOT a member of → fall back to oldest.
      expect((await resolveActiveWorkspaceForUser(userId, wsForeign))?.id).toBe(wsOld);
      // Selected org is inactive (member, but getWorkspaceById filters active) → fall back.
      expect((await resolveActiveWorkspaceForUser(userId, wsInactive))?.id).toBe(wsOld);
    } finally {
      for (const id of [wsOld, wsNew, wsInactive, wsForeign]) {
        await sqlRun(`DELETE FROM workspace_members WHERE workspace_id = @id`, { id });
        await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id });
      }
      await sqlRun(`DELETE FROM users WHERE id = @id`, { id: userId });
    }
  });

  it("round-trips the session active workspace id (and null)", async () => {
    const userId = "user_mo_session";
    const wsId = "ws_mo_session";
    await seedWorkspace({ id: wsId, orgUrl: "https://dev.azure.com/itf-mo-session" });
    await seedUser({ id: userId, email: "mo-session@itf-multiorg.test" });

    try {
      const withWs = await persistSession({ userId, workspaceId: wsId });
      expect((await resolveSessionToken(withWs.token))?.activeWorkspaceId).toBe(wsId);

      const withoutWs = await persistSession({ userId });
      expect((await resolveSessionToken(withoutWs.token))?.activeWorkspaceId).toBeNull();
    } finally {
      await sqlRun(`DELETE FROM sessions WHERE user_id = @id`, { id: userId });
      await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id: wsId });
      await sqlRun(`DELETE FROM users WHERE id = @id`, { id: userId });
    }
  });

  it("disabling an org (soft) blocks login + resolution; re-enabling restores it", async () => {
    const userId = "user_mo_disable";
    const wsId = "ws_mo_disable";
    const orgUrl = "https://dev.azure.com/itf-mo-disable";
    await seedWorkspace({ id: wsId, orgUrl });
    await seedUser({ id: userId, email: "mo-disable@itf-multiorg.test" });
    await seedMembership({ workspaceId: wsId, userId, role: "owner" });

    try {
      // Active: sign-in lookup finds it, and it resolves as the user's workspace.
      expect((await findWorkspaceByAzureOrgUrl(orgUrl))?.id).toBe(wsId);
      expect((await getPrimaryWorkspaceForUser(userId))?.id).toBe(wsId);

      // Disable (soft) → invisible to login + resolution, membership row preserved.
      const disabled = await setWorkspaceStatusByOrgUrl(orgUrl, "inactive");
      expect(disabled?.id).toBe(wsId);
      expect(await findWorkspaceByAzureOrgUrl(orgUrl)).toBeNull();
      expect(await getPrimaryWorkspaceForUser(userId)).toBeNull();
      expect(await resolveActiveWorkspaceForUser(userId, wsId)).toBeNull();
      expect((await getWorkspaceMembership(userId, wsId))?.role).toBe("owner"); // data preserved

      // Re-enable → fully restored.
      await setWorkspaceStatusByOrgUrl(orgUrl, "active");
      expect((await findWorkspaceByAzureOrgUrl(orgUrl))?.id).toBe(wsId);
      expect((await getPrimaryWorkspaceForUser(userId))?.id).toBe(wsId);

      // Unknown org → no-op, returns null.
      expect(await setWorkspaceStatusByOrgUrl("https://dev.azure.com/itf-mo-nope", "inactive")).toBeNull();
    } finally {
      await sqlRun(`DELETE FROM workspace_members WHERE workspace_id = @id`, { id: wsId });
      await sqlRun(`DELETE FROM workspaces WHERE id = @id`, { id: wsId });
      await sqlRun(`DELETE FROM users WHERE id = @id`, { id: userId });
    }
  });
});
