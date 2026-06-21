import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import {
  getWorkspaceMembership,
  requireWorkspaceAccess,
  requireWorkspaceRole,
  WorkspaceAccessError,
} from "@/modules/workspace/workspace-access.service";
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
});
