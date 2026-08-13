import "server-only";

import type { PoolClient } from "pg";

import { createId, nowIso, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import { isAllowedAtlassianCloudId, type AtlassianAccessibleResource, type AtlassianUserIdentity } from "./jira-oauth";

export type JiraLoginProvisioningResult = {
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "member";
};

export async function provisionJiraLogin(input: {
  resource: AtlassianAccessibleResource;
  identity: AtlassianUserIdentity;
}): Promise<JiraLoginProvisioningResult> {
  if (!isAllowedAtlassianCloudId(input.resource.id)) throw new Error("This Jira Cloud site is not approved.");
  return withTransaction(async (client) => {
    const now = nowIso();
    const createdWorkspace = await sqlGet<{ id: string }>(
      `INSERT INTO workspaces (
         id, name, azure_org_name, azure_org_url, provider_id,
         provider_site_id, provider_site_name, provider_site_url, status, created_at, updated_at
       ) VALUES (
         @id, @name, NULL, NULL, @providerId,
         @siteId, @siteName, @siteUrl, 'active', @now, @now
       )
       ON CONFLICT (provider_id, provider_site_id) WHERE provider_site_id IS NOT NULL DO NOTHING
       RETURNING id`,
      {
        id: createId("ws"), name: input.resource.name, providerId: "jira-cloud",
        siteId: input.resource.id.trim(), siteName: input.resource.name, siteUrl: input.resource.url, now,
      },
      client,
    );
    const workspace = createdWorkspace ?? await sqlGet<{ id: string }>(
      `SELECT id FROM workspaces
       WHERE provider_id = 'jira-cloud' AND provider_site_id = @siteId AND status = 'active'
       LIMIT 1`,
      { siteId: input.resource.id.trim() },
      client,
    );
    if (!workspace) throw new Error("Jira workspace could not be provisioned.");

    const external = await sqlGet<{ user_id: string }>(
      `SELECT user_id FROM external_identities
       WHERE provider_id = 'jira-cloud' AND provider_subject = @providerSubject
       LIMIT 1`,
      { providerSubject: input.identity.accountId },
      client,
    );
    let userId = external?.user_id;
    if (!userId) {
      const email = input.identity.emailAddress?.trim().toLocaleLowerCase() ?? null;
      const byEmail = email
        ? await sqlGet<{ id: string }>(
            `SELECT id FROM users WHERE LOWER(email_or_unique_name) = @email LIMIT 1`,
            { email }, client,
          )
        : undefined;
      const user = byEmail ?? await sqlGet<{ id: string }>(
        `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at, last_login_at)
         VALUES (@id, @displayName, @email, 'active', @now, @now)
         RETURNING id`,
        { id: createId("user"), displayName: input.identity.displayName, email, now },
        client,
      );
      if (!user) throw new Error("Jira user could not be provisioned.");
      userId = user.id;
      await sqlRun(
        `INSERT INTO external_identities (
           id, user_id, provider_id, provider_subject, email, display_name, created_at, last_login_at
         ) VALUES (
           @id, @userId, 'jira-cloud', @providerSubject, @email, @displayName, @now, @now
         )`,
        {
          id: createId("extid"), userId, providerSubject: input.identity.accountId,
          email, displayName: input.identity.displayName, now,
        },
        client,
      );
    } else {
      await updateJiraIdentity(userId, input.identity, now, client);
    }

    const requestedRole = createdWorkspace ? "owner" : "member";
    const membership = await sqlGet<{ role: "owner" | "admin" | "member" }>(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (@id, @workspaceId, @userId, @role, 'active', @now, @now)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at
       RETURNING role`,
      { id: createId("wm"), workspaceId: workspace.id, userId, role: requestedRole, now },
      client,
    );
    if (!membership) throw new Error("Jira workspace membership could not be provisioned.");
    return { workspaceId: workspace.id, userId, role: membership.role };
  });
}

async function updateJiraIdentity(userId: string, identity: AtlassianUserIdentity, now: string, client: PoolClient) {
  await sqlRun(
    `UPDATE external_identities
     SET email = @email, display_name = @displayName, last_login_at = @now
     WHERE provider_id = 'jira-cloud' AND provider_subject = @providerSubject`,
    { email: identity.emailAddress, displayName: identity.displayName, now, providerSubject: identity.accountId },
    client,
  );
  await sqlRun(
    `UPDATE users SET display_name = @displayName, last_login_at = @now, status = 'active' WHERE id = @userId`,
    { userId, displayName: identity.displayName, now },
    client,
  );
}
