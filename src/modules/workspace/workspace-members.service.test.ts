import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createId, nowIso, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureBootstrapOwner } from "@/modules/auth/bootstrap.service";
import {
  listWorkspaceMembers,
  MemberActionError,
  removeMember,
  updateMemberRole,
} from "@/modules/workspace/workspace-members.service";

const TEST_EMAIL = "owner-members@itestflow.test";
const TEST_ORG = "itestflow-members-test-org";
const TEST_ORG_URL = "https://dev.azure.com/itestflow-members-test-org";
const MEMBER_EMAIL_SUFFIX = "@members-test.itestflow.test";

// DB-backed integration test (ADR-9): requires a migrated PostgreSQL via
// DATABASE_URL; skipped otherwise so the default unit run needs no database.
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

async function addMember(workspaceId: string, name: string, role: "owner" | "admin" | "member"): Promise<string> {
  const now = nowIso();
  const userId = createId("user");
  await sqlRun(
    `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
     VALUES (@id, @name, @email, 'active', @now)`,
    { id: userId, name, email: `${name}${MEMBER_EMAIL_SUFFIX}`, now },
  );
  await sqlRun(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
     VALUES (@id, @workspaceId, @userId, @role, 'active', @now, @now)`,
    { id: createId("wm"), workspaceId, userId, role, now },
  );
  return userId;
}

async function cleanup() {
  await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
  await sqlRun(`DELETE FROM users WHERE email_or_unique_name = @email`, { email: TEST_EMAIL });
  await sqlRun(`DELETE FROM users WHERE email_or_unique_name LIKE @like`, { like: `%${MEMBER_EMAIL_SUFFIX}` });
}

describeDb("workspace member management (DB-backed)", () => {
  let workspaceId: string;
  let ownerUserId: string;

  beforeAll(async () => {
    process.env.BOOTSTRAP_OWNER_EMAIL = TEST_EMAIL;
    process.env.BOOTSTRAP_OWNER_AZURE_ORG = TEST_ORG;
    await cleanup();
    const bootstrap = await ensureBootstrapOwner();
    workspaceId = bootstrap!.workspaceId;
    ownerUserId = bootstrap!.userId;
  });

  afterAll(async () => {
    await cleanup();
    await resetDatabaseForTests();
  });

  it("lists active members owners-first, joined with user identity", async () => {
    await addMember(workspaceId, "alice", "member");
    await addMember(workspaceId, "bob", "admin");

    const members = await listWorkspaceMembers(workspaceId);
    expect(members.length).toBeGreaterThanOrEqual(3);
    expect(members[0]?.role).toBe("owner");
    const roles = members.map((m) => m.role);
    expect(roles.indexOf("admin")).toBeLessThan(roles.lastIndexOf("member"));
    expect(members.find((m) => m.email === `alice${MEMBER_EMAIL_SUFFIX}`)?.displayName).toBe("alice");
  });

  it("lets an owner promote a member to admin", async () => {
    const members = await listWorkspaceMembers(workspaceId);
    const alice = members.find((m) => m.email === `alice${MEMBER_EMAIL_SUFFIX}`)!;
    await updateMemberRole({
      workspaceId,
      membershipId: alice.membershipId,
      newRole: "admin",
      actor: { userId: ownerUserId, role: "owner" },
    });
    const after = await listWorkspaceMembers(workspaceId);
    expect(after.find((m) => m.membershipId === alice.membershipId)?.role).toBe("admin");
  });

  it("forbids an admin from granting owner or modifying an owner (403)", async () => {
    const members = await listWorkspaceMembers(workspaceId);
    const bob = members.find((m) => m.email === `bob${MEMBER_EMAIL_SUFFIX}`)!;
    const owner = members.find((m) => m.role === "owner")!;

    // Admin tries to grant owner.
    await expect(
      updateMemberRole({
        workspaceId,
        membershipId: bob.membershipId,
        newRole: "owner",
        actor: { userId: bob.userId, role: "admin" },
      }),
    ).rejects.toMatchObject({ status: 403 });

    // Admin tries to touch an owner.
    await expect(
      updateMemberRole({
        workspaceId,
        membershipId: owner.membershipId,
        newRole: "member",
        actor: { userId: bob.userId, role: "admin" },
      }),
    ).rejects.toBeInstanceOf(MemberActionError);
  });

  it("never demotes or removes the last owner (409)", async () => {
    const owner = (await listWorkspaceMembers(workspaceId)).find((m) => m.role === "owner")!;
    await expect(
      updateMemberRole({
        workspaceId,
        membershipId: owner.membershipId,
        newRole: "member",
        actor: { userId: ownerUserId, role: "owner" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      removeMember({ workspaceId, membershipId: owner.membershipId, actor: { userId: ownerUserId, role: "owner" } }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("404s on a membership from another workspace / unknown id", async () => {
    await expect(
      removeMember({ workspaceId, membershipId: "wm_nope", actor: { userId: ownerUserId, role: "owner" } }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("lets an owner remove a member", async () => {
    const bob = (await listWorkspaceMembers(workspaceId)).find((m) => m.email === `bob${MEMBER_EMAIL_SUFFIX}`)!;
    await removeMember({ workspaceId, membershipId: bob.membershipId, actor: { userId: ownerUserId, role: "owner" } });
    const after = await listWorkspaceMembers(workspaceId);
    expect(after.find((m) => m.membershipId === bob.membershipId)).toBeUndefined();
  });
});
