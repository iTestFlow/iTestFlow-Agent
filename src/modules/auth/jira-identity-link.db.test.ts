import { afterAll, expect, it } from "vitest";

import { nowIso, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedUser, uniqueTestId } from "@/test/db";
import { getJiraIdentityLinkStatus } from "./user.service";

describeDb("Jira credential replacement identity ownership", () => {
  const userIds: string[] = [];

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [], userIds });
    await resetDatabaseForTests();
  });

  async function user() {
    const id = uniqueTestId("jira_link_user");
    userIds.push(id);
    await seedUser({ id, email: `${id}@itestflow.test` });
    return id;
  }

  async function link(userId: string, subject: string, providerId = "jira-cloud") {
    await sqlRun(
      `INSERT INTO external_identities (id, user_id, provider_id, provider_subject, email, display_name, created_at, last_login_at)
       VALUES (@id, @userId, @providerId, @subject, @email, 'Linked account', @now, @now)`,
      { id: uniqueTestId("jira_link_identity"), userId, subject, providerId, email: "profile@example.test", now: nowIso() },
    );
  }

  it("requires initial Jira sign-in even when the subject is linked through Azure", async () => {
    const userId = await user();
    const subject = uniqueTestId("account");
    await expect(getJiraIdentityLinkStatus(userId, subject)).resolves.toBe("unlinked");
    await link(userId, subject, "azure-devops");
    await expect(getJiraIdentityLinkStatus(userId, subject)).resolves.toBe("unlinked");
  });

  it("accepts each exact Jira subject linked to the user, regardless of identity order", async () => {
    const userId = await user();
    const first = uniqueTestId("account");
    const second = uniqueTestId("account");
    await link(userId, first);
    await link(userId, second);
    await expect(getJiraIdentityLinkStatus(userId, first)).resolves.toBe("linked");
    await expect(getJiraIdentityLinkStatus(userId, second)).resolves.toBe("linked");
    await expect(getJiraIdentityLinkStatus(userId, second.toUpperCase())).resolves.toBe("mismatch");
  });

  it("rejects another user's subject and never falls back to matching profile email", async () => {
    const firstUser = await user();
    const secondUser = await user();
    const firstSubject = uniqueTestId("account");
    const secondSubject = uniqueTestId("account");
    // Both identity rows expose the same email, but ownership is by stable subject.
    await link(firstUser, firstSubject);
    await link(secondUser, secondSubject);
    await expect(getJiraIdentityLinkStatus(firstUser, secondSubject)).resolves.toBe("mismatch");
    await expect(getJiraIdentityLinkStatus(secondUser, firstSubject)).resolves.toBe("mismatch");
    await expect(getJiraIdentityLinkStatus(firstUser, uniqueTestId("unknown"))).resolves.toBe("mismatch");
  });
});
