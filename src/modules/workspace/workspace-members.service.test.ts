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
const ADMIN_GUARD_ORG_URL = "https://dev.azure.com/itestflow-admin-guard-test-org";
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

async function addWorkspace(name: string, orgUrl: string): Promise<string> {
  const now = nowIso();
  const workspaceId = createId("ws");
  await sqlRun(
    `INSERT INTO workspaces (id, name, azure_org_name, azure_org_url, status, created_at, updated_at)
     VALUES (@id, @name, @orgName, @orgUrl, 'active', @now, @now)`,
    { id: workspaceId, name, orgName: name, orgUrl, now },
  );
  return workspaceId;
}

async function cleanup() {
  await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: TEST_ORG_URL });
  await sqlRun(`DELETE FROM workspaces WHERE azure_org_url = @url`, { url: ADMIN_GUARD_ORG_URL });
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

  it("forbids an admin from managing a peer admin; only an owner can (403)", async () => {
    const carolId = await addMember(workspaceId, "carol", "admin");
    const daveId = await addMember(workspaceId, "dave", "admin");
    const dave = (await listWorkspaceMembers(workspaceId)).find((m) => m.userId === daveId)!;

    // An admin may not demote a peer admin...
    await expect(
      updateMemberRole({
        workspaceId,
        membershipId: dave.membershipId,
        newRole: "member",
        actor: { userId: carolId, role: "admin" },
      }),
    ).rejects.toMatchObject({ status: 403 });
    // ...nor remove one.
    await expect(
      removeMember({ workspaceId, membershipId: dave.membershipId, actor: { userId: carolId, role: "admin" } }),
    ).rejects.toMatchObject({ status: 403 });

    // An owner can.
    await updateMemberRole({
      workspaceId,
      membershipId: dave.membershipId,
      newRole: "member",
      actor: { userId: ownerUserId, role: "owner" },
    });
    expect((await listWorkspaceMembers(workspaceId)).find((m) => m.membershipId === dave.membershipId)?.role).toBe("member");
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

  it("never demotes or removes the last admin (409)", async () => {
    const adminGuardWorkspaceId = await addWorkspace("itestflow-admin-guard", ADMIN_GUARD_ORG_URL);
    const guardOwnerId = await addMember(adminGuardWorkspaceId, "admin-guard-owner", "owner");
    await addMember(adminGuardWorkspaceId, "admin-guard-admin", "admin");
    const admin = (await listWorkspaceMembers(adminGuardWorkspaceId)).find((m) => m.role === "admin")!;

    await expect(
      updateMemberRole({
        workspaceId: adminGuardWorkspaceId,
        membershipId: admin.membershipId,
        newRole: "member",
        actor: { userId: guardOwnerId, role: "owner" },
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      updateMemberRole({
        workspaceId: adminGuardWorkspaceId,
        membershipId: admin.membershipId,
        newRole: "owner",
        actor: { userId: guardOwnerId, role: "owner" },
      }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      removeMember({
        workspaceId: adminGuardWorkspaceId,
        membershipId: admin.membershipId,
        actor: { userId: guardOwnerId, role: "owner" },
      }),
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
