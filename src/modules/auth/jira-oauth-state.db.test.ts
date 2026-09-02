import { afterAll, beforeAll, expect, it } from "vitest";

import { sqlAll, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedWorkspace, uniqueTestId } from "@/test/db";

import { createJiraOAuthState } from "./jira-oauth-state";

const workspaceId = uniqueTestId("ws_oauthstate_cleanup");
const expiredStateId = uniqueTestId("oauthstate_expired");
const liveStateId = uniqueTestId("oauthstate_live");
const createdReturnTo = `/${uniqueTestId("oauth_return")}`;

async function insertState(input: { id: string; expiresAt: string }): Promise<void> {
  await sqlRun(
    `INSERT INTO jira_oauth_states (
       id, state_hash, browser_binding_hash, return_to,
       selected_workspace_id, selected_site_url, selected_cloud_id,
       created_at, expires_at
     ) VALUES (
       @id, @stateHash, @browserBindingHash, '/dashboards',
       @workspaceId, 'https://cleanup.atlassian.net', 'cloud-cleanup',
       @createdAt, @expiresAt
     )`,
    {
      id: input.id,
      stateHash: `hash_${input.id}`,
      browserBindingHash: `binding_${input.id}`,
      workspaceId,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: input.expiresAt,
    },
  );
}

describeDb("Jira OAuth state expiry cleanup (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl: `https://dev.azure.com/${workspaceId}` });
    await insertState({ id: expiredStateId, expiresAt: "2026-01-01T00:00:00.000Z" });
    await insertState({ id: liveStateId, expiresAt: "2099-01-01T00:00:00.000Z" });
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [] });
  });

  it("deletes expired rows, retains future rows, and inserts the new state atomically", async () => {
    await createJiraOAuthState(createdReturnTo, "cleanup-binding", {
      workspaceId,
      siteUrl: "https://cleanup.atlassian.net",
      cloudId: "cloud-cleanup",
    });

    const rows = await sqlAll<{ id: string; return_to: string; expires_at: string }>(
      `SELECT id, return_to, expires_at
       FROM jira_oauth_states
       WHERE selected_workspace_id = @workspaceId`,
      { workspaceId },
    );

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === expiredStateId)).toBeUndefined();
    expect(rows.find((row) => row.id === liveStateId)).toMatchObject({
      return_to: "/dashboards",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    expect(rows.find((row) => row.return_to === createdReturnTo)).toMatchObject({
      return_to: createdReturnTo,
    });
  });
});
