import { afterAll, expect, it } from "vitest";

import { nowIso, resetDatabaseForTests, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ensureWorkspaceMembership, provisionUserFromIdentity } from "@/modules/auth/user.service";
import { getWorkspaceMembership } from "@/modules/workspace/workspace-access.service";
import { cleanupFixtures, describeDb, seedMembership, seedUser, seedWorkspace, uniqueTestId } from "@/test/db";

// DB-backed (ADR-9): requires a migrated PostgreSQL via DATABASE_URL. The
// reconciliation contract lives in SQL (the ORDER BY preference, both unique keys
// on users, ON CONFLICT on workspace_members), so it is pinned against the real
// database. Every fixture id/email/org URL is per-run-unique (uniqueTestId) —
// other suites may run against the same database concurrently.

const EMAIL_DOMAIN = "itf-user-service.test";

function uniqueEmail(prefix: string): string {
  return `${uniqueTestId(prefix)}@${EMAIL_DOMAIN}`;
}

async function userRow(id: string) {
  return sqlGet<{
    azure_identity_id: string | null;
    email_or_unique_name: string | null;
    display_name: string | null;
    last_login_at: string | null;
    status: string;
  }>(
    `SELECT azure_identity_id, email_or_unique_name, display_name, last_login_at, status
     FROM users WHERE id = @id`,
    { id },
  );
}

/** Ids of every user row matching either reconciliation key (the dedupe invariant). */
async function usersMatching(azureId: string, email: string): Promise<string[]> {
  const rows = await sqlAll<{ id: string }>(
    `SELECT id FROM users WHERE azure_identity_id = @azureId OR email_or_unique_name = @email ORDER BY id`,
    { azureId, email },
  );
  return rows.map((r) => r.id);
}

/** seedUser leaves azure_identity_id NULL (bootstrap shape); this seeds a fully-linked user. */
async function seedUserWithIdentity(input: { id: string; email: string; azureIdentityId: string }): Promise<void> {
  await sqlRun(
    `INSERT INTO users (id, display_name, email_or_unique_name, azure_identity_id, status, created_at)
     VALUES (@id, @id, @email, @azureId, 'active', @now)`,
    { id: input.id, email: input.email, azureId: input.azureIdentityId, now: nowIso() },
  );
}

/** Resolves to the rejection (typed to the pg DatabaseError fields we assert), or null on success. */
async function provisioningError(promise: Promise<string>): Promise<{ code?: string; constraint?: string } | null> {
  return promise.then(
    () => null,
    (error) => error as { code?: string; constraint?: string },
  );
}

describeDb("user provisioning & membership reconciliation (DB-backed)", () => {
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds, userIds });
    await resetDatabaseForTests();
  });

  it("upgrades a bootstrap-seeded user (email set, azure_identity_id NULL) in place on first login", async () => {
    const userId = uniqueTestId("user");
    const email = uniqueEmail("bootstrap");
    const azureId = uniqueTestId("aad");
    userIds.push(userId);
    await seedUser({ id: userId, email });

    const provisionedId = await provisionUserFromIdentity({
      azureIdentityId: azureId,
      displayName: "Bootstrap Owner",
      emailOrUniqueName: email,
    });

    // Same row, upgraded — not a sibling insert.
    expect(provisionedId).toBe(userId);
    const row = await userRow(userId);
    expect(row?.azure_identity_id).toBe(azureId);
    expect(row?.email_or_unique_name).toBe(email);
    expect(row?.display_name).toBe("Bootstrap Owner");
    expect(row?.last_login_at).not.toBeNull();
    expect(row?.status).toBe("active");
    // Exactly one row holds either unique key.
    expect(await usersMatching(azureId, email)).toEqual([userId]);
  });

  it("is idempotent: re-provisioning the same identity returns the same row and refreshes the profile", async () => {
    const email = uniqueEmail("repeat");
    const azureId = uniqueTestId("aad");

    const first = await provisionUserFromIdentity({
      azureIdentityId: azureId,
      displayName: "First Login",
      emailOrUniqueName: email,
    });
    userIds.push(first);
    const second = await provisionUserFromIdentity({
      azureIdentityId: azureId,
      displayName: "Second Login",
      emailOrUniqueName: email,
    });

    expect(second).toBe(first);
    expect(await usersMatching(azureId, email)).toEqual([first]);
    expect((await userRow(first))?.display_name).toBe("Second Login");
  });

  it("prefers the azure_identity_id holder over an email-only match when both rows carry identities", async () => {
    const identityHolder = uniqueTestId("user");
    const holderEmail = uniqueEmail("holder");
    const azureId = uniqueTestId("aad");
    const emailOnly = uniqueTestId("user");
    const contestedEmail = uniqueEmail("contested");
    userIds.push(identityHolder, emailOnly);
    await seedUserWithIdentity({ id: identityHolder, email: holderEmail, azureIdentityId: azureId });
    await seedUserWithIdentity({ id: emailOnly, email: contestedEmail, azureIdentityId: uniqueTestId("aad") });

    // Both rows match the reconciliation SELECT; the ORDER BY picks the identity
    // holder (true sorts above false). The violated constraint proves which row
    // the UPDATE targeted: the winner's email update collides with the row that
    // still holds the contested email — reconciliation cannot merge two rows.
    const error = await provisioningError(
      provisionUserFromIdentity({
        azureIdentityId: azureId,
        displayName: "Identity Wins",
        emailOrUniqueName: contestedEmail,
      }),
    );
    expect(error?.code).toBe("23505");
    expect(error?.constraint).toBe("users_email_or_unique_name_key");

    // The failed statement is atomic: neither row was modified.
    expect((await userRow(identityHolder))?.email_or_unique_name).toBe(holderEmail);
    expect((await userRow(emailOnly))?.azure_identity_id).not.toBe(azureId);
  });

  it("email-only match with a NULL identity (bootstrap shape) defeats the identity preference: Postgres DESC sorts NULLs first", async () => {
    const identityHolder = uniqueTestId("user");
    const azureId = uniqueTestId("aad");
    const bootstrapUser = uniqueTestId("user");
    const bootstrapEmail = uniqueEmail("bootstrap-null");
    userIds.push(identityHolder, bootstrapUser);
    await seedUserWithIdentity({ id: identityHolder, email: uniqueEmail("holder-null"), azureIdentityId: azureId });
    await seedUser({ id: bootstrapUser, email: bootstrapEmail }); // azure_identity_id NULL

    // Divergence from the service's documented intent ("upgraded in place ...
    // rather than colliding"): for the NULL-identity row the ORDER BY expression
    // is NULL, and DESC places NULLs FIRST in Postgres, so the bootstrap row wins
    // the SELECT. Its UPDATE then collides on the already-taken azure_identity_id.
    const error = await provisioningError(
      provisionUserFromIdentity({
        azureIdentityId: azureId,
        displayName: "Null Sorts First",
        emailOrUniqueName: bootstrapEmail,
      }),
    );
    expect(error?.code).toBe("23505");
    expect(error?.constraint).toBe("users_azure_identity_id_key");

    // Atomic failure: the bootstrap row is still unlinked.
    expect((await userRow(bootstrapUser))?.azure_identity_id).toBeNull();
  });

  it("ensureWorkspaceMembership is idempotent and never demotes an existing role", async () => {
    const wsId = uniqueTestId("ws");
    workspaceIds.push(wsId);
    await seedWorkspace({ id: wsId, orgUrl: `https://dev.azure.com/${uniqueTestId("itf-usvc")}` });

    const memberId = uniqueTestId("user");
    userIds.push(memberId);
    await seedUser({ id: memberId, email: uniqueEmail("member") });
    await ensureWorkspaceMembership(wsId, memberId);
    await ensureWorkspaceMembership(wsId, memberId); // ON CONFLICT DO NOTHING: single row
    expect((await getWorkspaceMembership(memberId, wsId))?.role).toBe("member");
    const rows = await sqlAll<{ id: string }>(
      `SELECT id FROM workspace_members WHERE workspace_id = @ws AND user_id = @user`,
      { ws: wsId, user: memberId },
    );
    expect(rows).toHaveLength(1);

    // A later default-role ensure must not demote an owner.
    const ownerId = uniqueTestId("user");
    userIds.push(ownerId);
    await seedUser({ id: ownerId, email: uniqueEmail("owner") });
    await seedMembership({ workspaceId: wsId, userId: ownerId, role: "owner" });
    await ensureWorkspaceMembership(wsId, ownerId, "member");
    expect((await getWorkspaceMembership(ownerId, wsId))?.role).toBe("owner");
  });
});
