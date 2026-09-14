import "server-only";

import type { PoolClient } from "pg";

import { createId, nowIso, sqlAll, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import { canonicalJiraSiteUrl } from "./bootstrap.service";
import type { JiraSiteResource, JiraUserIdentity } from "./jira-token-auth.service";

export type JiraLoginProvisioningResult = {
  workspaceId: string;
  userId: string;
  role: "owner" | "admin" | "member";
};

/** An authenticated site with no configured workspace: fail closed, never lazily create. */
export class JiraSiteNotConfiguredError extends Error {
  constructor() {
    super("This Jira site is not configured for iTestFlow.");
    this.name = "JiraSiteNotConfiguredError";
  }
}

type JiraWorkspaceCandidate = {
  id: string;
  provider_site_id: string | null;
  provider_site_url: string | null;
  status: string;
};

type WorkspaceMembershipRow = {
  id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  status: string;
};

export async function provisionJiraLogin(input: {
  resource: JiraSiteResource;
  identity: JiraUserIdentity;
}): Promise<JiraLoginProvisioningResult> {
  return withTransaction(async (client) => {
    const now = nowIso();
    const siteId = input.resource.cloudId.trim();
    const siteName = input.resource.siteName;
    const siteUrl = canonicalJiraSiteUrl(input.resource.siteUrl);
    const workspaceId = await resolveJiraWorkspace({ siteId, siteName, siteUrl, now }, client);

    const external = await sqlGet<{ user_id: string }>(
      `SELECT user_id FROM external_identities
       WHERE provider_id = 'jira-cloud' AND provider_subject = @providerSubject
       LIMIT 1`,
      { providerSubject: input.identity.accountId },
      client,
    );
    let userId = external?.user_id;
    if (!userId) {
      // The identity email is the Basic-auth-verified, normalized typed email —
      // always present, so the bootstrap-seeded owner (keyed by that email)
      // always reconciles in place instead of duplicating.
      const email = input.identity.emailAddress.trim().toLowerCase();
      const byEmail = await sqlGet<{ id: string }>(
        `SELECT id FROM users WHERE LOWER(email_or_unique_name) = @email LIMIT 1`,
        { email }, client,
      );
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

    // Configured-site trust boundary: bootstrap seeds owners; everyone who can
    // authenticate against the configured site joins as 'member' (matching the
    // Azure enabled-org policy). Login never creates a workspace.
    const membership = await sqlGet<{ role: "owner" | "admin" | "member" }>(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (@id, @workspaceId, @userId, 'member', 'active', @now, @now)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at
       RETURNING role`,
      { id: createId("wm"), workspaceId, userId, now },
      client,
    );
    if (!membership) throw new Error("Jira workspace membership could not be provisioned.");
    return { workspaceId, userId, role: membership.role };
  });
}

/**
 * Resolve the configured workspace for an authenticated site: adopt the seeded
 * placeholder (pinning the cloud ID on first login), reconcile a rename, or
 * fail closed. An unconfigured site NEVER lazily creates a workspace — the
 * login route already rejects unknown sites, and this guard keeps provisioning
 * fail-closed even if a caller bypasses it.
 */
async function resolveJiraWorkspace(
  input: { siteId: string; siteName: string; siteUrl: string; now: string },
  client: PoolClient,
): Promise<string> {
  const candidates = await lockJiraWorkspaceCandidates(input.siteId, input.siteUrl, client);
  const existing = await resolveLockedJiraWorkspace(candidates, input, client);
  if (!existing) throw new JiraSiteNotConfiguredError();
  return existing;
}

async function lockJiraWorkspaceCandidates(
  siteId: string,
  siteUrl: string,
  client: PoolClient,
): Promise<JiraWorkspaceCandidate[]> {
  return sqlAll<JiraWorkspaceCandidate>(
    `SELECT id, provider_site_id, provider_site_url, status
     FROM workspaces
     WHERE provider_id = 'jira-cloud'
       AND (provider_site_id = @siteId OR provider_site_url = @siteUrl)
     ORDER BY id ASC
     FOR UPDATE`,
    { siteId, siteUrl },
    client,
  );
}

async function resolveLockedJiraWorkspace(
  candidates: JiraWorkspaceCandidate[],
  input: { siteId: string; siteName: string; siteUrl: string; now: string },
  client: PoolClient,
): Promise<string | undefined> {
  if (candidates.length === 0) return undefined;
  if (candidates.some((candidate) => candidate.status !== "active")) {
    throw new Error("Jira workspace collision includes an inactive workspace.");
  }

  const targets = candidates.filter((candidate) => candidate.provider_site_id === input.siteId);
  const occupants = candidates.filter((candidate) => candidate.provider_site_url === input.siteUrl);
  if (targets.length > 1 || occupants.length > 1) {
    throw new Error("Jira workspace collision has an ambiguous identity shape.");
  }

  const target = targets[0];
  const occupant = occupants[0];
  if (occupant?.provider_site_id && occupant.provider_site_id !== input.siteId) {
    throw new Error("Jira workspace collision belongs to a different Atlassian cloud ID.");
  }

  if (!target && occupant) {
    await requireSingleMutation(
      sqlRun(
        `UPDATE workspaces
         SET provider_site_id = @siteId, provider_site_name = @siteName,
             provider_site_url = @siteUrl, name = @siteName, updated_at = @now
         WHERE id = @workspaceId AND provider_id = 'jira-cloud'
           AND provider_site_id IS NULL AND status = 'active'`,
        { ...input, workspaceId: occupant.id },
        client,
      ),
      "Jira bootstrap workspace adoption failed.",
    );
    return occupant.id;
  }

  if (!target) {
    throw new Error("Jira workspace collision has no resolvable target.");
  }

  if (occupant && occupant.id !== target.id) {
    await reconcileJiraPlaceholder(target.id, occupant.id, input.now, client);
  }
  await refreshJiraWorkspace(target.id, input, client);
  return target.id;
}

async function reconcileJiraPlaceholder(
  targetId: string,
  placeholderId: string,
  now: string,
  client: PoolClient,
): Promise<void> {
  const memberships = await sqlAll<WorkspaceMembershipRow>(
    `SELECT id, user_id, role, status
     FROM workspace_members
     WHERE workspace_id = @placeholderId
     ORDER BY id ASC
     FOR UPDATE`,
    { placeholderId },
    client,
  );
  const activeMemberships = memberships.filter((membership) => membership.status === "active");
  if (activeMemberships.length !== 1 || activeMemberships[0].role !== "owner") {
    throw new Error("Jira bootstrap placeholder must contain exactly one active owner membership.");
  }

  const owner = activeMemberships[0];
  const targetMembership = await sqlGet<{ id: string }>(
    `SELECT id FROM workspace_members
     WHERE workspace_id = @targetId AND user_id = @userId
     FOR UPDATE`,
    { targetId, userId: owner.user_id },
    client,
  );
  if (targetMembership) {
    await requireSingleMutation(
      sqlRun(
        `UPDATE workspace_members
         SET role = 'owner', status = 'active', updated_at = @now
         WHERE id = @membershipId AND workspace_id = @targetId`,
        { membershipId: targetMembership.id, targetId, now },
        client,
      ),
      "Jira target owner membership could not be activated.",
    );
    await requireSingleMutation(
      sqlRun(
        `UPDATE workspace_members
         SET status = 'inactive', updated_at = @now
         WHERE id = @membershipId AND workspace_id = @placeholderId AND status = 'active'`,
        { membershipId: owner.id, placeholderId, now },
        client,
      ),
      "Jira placeholder owner membership could not be retired.",
    );
  } else {
    await requireSingleMutation(
      sqlRun(
        `UPDATE workspace_members
         SET workspace_id = @targetId, updated_at = @now
         WHERE id = @membershipId AND workspace_id = @placeholderId AND status = 'active'`,
        { membershipId: owner.id, placeholderId, targetId, now },
        client,
      ),
      "Jira placeholder owner membership could not be re-pointed.",
    );
  }

  // The URL uniqueness index includes inactive rows. Clear the placeholder's
  // URL before assigning it to the cloud-ID-backed target.
  await requireSingleMutation(
    sqlRun(
      `UPDATE workspaces
       SET status = 'inactive', provider_site_url = NULL, updated_at = @now
       WHERE id = @placeholderId AND provider_id = 'jira-cloud'
         AND provider_site_id IS NULL AND status = 'active'`,
      { placeholderId, now },
      client,
    ),
    "Jira bootstrap placeholder could not be retired.",
  );
}

async function refreshJiraWorkspace(
  workspaceId: string,
  input: { siteId: string; siteName: string; siteUrl: string; now: string },
  client: PoolClient,
): Promise<void> {
  await requireSingleMutation(
    sqlRun(
      `UPDATE workspaces
       SET name = @siteName, provider_site_name = @siteName,
           provider_site_url = @siteUrl, updated_at = @now
       WHERE id = @workspaceId AND provider_id = 'jira-cloud'
         AND provider_site_id = @siteId AND status = 'active'`,
      { ...input, workspaceId },
      client,
    ),
    "Jira workspace metadata could not be refreshed.",
  );
}

async function requireSingleMutation(mutation: Promise<number>, message: string): Promise<void> {
  if (await mutation !== 1) throw new Error(message);
}

async function updateJiraIdentity(userId: string, identity: JiraUserIdentity, now: string, client: PoolClient) {
  await sqlRun(
    `UPDATE external_identities
     SET email = @email, display_name = @displayName, last_login_at = @now
     WHERE provider_id = 'jira-cloud' AND provider_subject = @providerSubject`,
    { email: identity.emailAddress.trim().toLowerCase(), displayName: identity.displayName, now, providerSubject: identity.accountId },
    client,
  );
  await sqlRun(
    `UPDATE users SET display_name = @displayName, last_login_at = @now, status = 'active' WHERE id = @userId`,
    { userId, displayName: identity.displayName, now },
    client,
  );
}
