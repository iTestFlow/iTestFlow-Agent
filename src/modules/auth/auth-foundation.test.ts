import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createId, nowIso, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import {
  getWorkspaceMembership,
  requireWorkspaceAccess,
  requireWorkspaceRole,
  WorkspaceAccessError,
} from "@/modules/workspace/workspace-access.service";
import { getWorkspaceById, getWorkspacesForUser } from "@/modules/workspace/workspace.service";
import { persistSession, resolveSessionToken, revokeSessionToken } from "@/modules/auth/session.service";

const TEST_EMAIL = "owner@itestflow.test";
const TEST_ORG = "itestflow-test-org";
const TEST_ORG_URL = "https://dev.azure.com/itestflow-test-org";

// DB-backed integration test (ADR-9): requires a migrated PostgreSQL via
// DATABASE_URL; skipped otherwise so the default unit run needs no database.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb("auth & workspace foundation (DB-backed)", () => {
  beforeAll(async () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = TEST_EMAIL;
    process.env.BOOTSTRAP_OWNER_AZURE_ORG = TEST_ORG;
    delete process.env.BOOTSTRAP_AZURE_ORGS; // exercise the legacy single-org path exactly
    // Start from a clean slate in case a prior run left rows.
    await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
    await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email: TEST_EMAIL });
  });

  afterAll(async () => {
    await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
    await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email: TEST_EMAIL });
    await resetDatabaseForTests();
  });

  it("bootstraps owner + workspace idempotently", async () => {
    const first = await ensureBootstrapOwner();
    const second = await ensureBootstrapOwner();
    expect(first).not.toBeNull();
    expect(second).toEqual(first);

    const membership = await getWorkspaceMembership(first!.userId, first!.workspaceId);
    expect(membership?.role).toBe("owner");
  });

  it("promotes an existing bootstrap member to owner", async () => {
    await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
    await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email: TEST_EMAIL });

    const now = nowIso();
    const workspaceId = createId("ws");
    const userId = createId("user");
    await sqlRun(
      `INSERT INTO workspaces (id, name, azure_org_name, azure_org_url, status, created_at, updated_at)
       VALUES (@id, @name, @orgName, @orgUrl, 'active', @now, @now)`,
      { id: workspaceId, name: TEST_ORG, orgName: TEST_ORG, orgUrl: TEST_ORG_URL, now },
    );
    await sqlRun(
      `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
       VALUES (@id, @displayName, @email, 'active', @now)`,
      { id: userId, displayName: TEST_EMAIL, email: TEST_EMAIL, now },
    );
    await sqlRun(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (@id, @workspaceId, @userId, 'member', 'active', @now, @now)`,
      { id: createId("wm"), workspaceId, userId, now },
    );

    const bootstrap = await ensureBootstrapOwner();

    expect(bootstrap).toEqual({ workspaceId, userId });
    const membership = await getWorkspaceMembership(userId, workspaceId);
    expect(membership?.role).toBe("owner");
  });

  it("enforces workspace access and role", async () => {
    const bootstrap = await ensureBootstrapOwner();
    const { userId, workspaceId } = bootstrap!;

    await expect(requireWorkspaceAccess(userId, workspaceId)).resolves.toMatchObject({ role: "owner" });
    await expect(requireWorkspaceAccess("user_nonexistent", workspaceId)).rejects.toBeInstanceOf(WorkspaceAccessError);

    await expect(requireWorkspaceRole(userId, workspaceId, ["owner", "admin"])).resolves.toMatchObject({ role: "owner" });
    await expect(requireWorkspaceRole(userId, workspaceId, ["member"])).rejects.toBeInstanceOf(WorkspaceAccessError);
  });

  it("persists and resolves an opaque session, and honors revocation", async () => {
    const bootstrap = await ensureBootstrapOwner();
    const { userId } = bootstrap!;

    const { token } = await persistSession({ userId });
    expect((await resolveSessionToken(token))?.userId).toBe(userId);

    await revokeSessionToken(token);
    expect(await resolveSessionToken(token)).toBeNull();
    expect(await resolveSessionToken("not-a-real-token")).toBeNull();
  });

  it("looks up workspaces by id and by user (workspaceId validation primitives)", async () => {
    const bootstrap = await ensureBootstrapOwner();
    const { userId, workspaceId } = bootstrap!;

    expect((await getWorkspaceById(workspaceId))?.id).toBe(workspaceId);
    expect(await getWorkspaceById("ws_does_not_exist")).toBeNull();

    const list = await getWorkspacesForUser(userId);
    expect(list.map((w) => w.id)).toContain(workspaceId);
    expect(list.find((w) => w.id === workspaceId)?.role).toBe("owner");
  });
});
