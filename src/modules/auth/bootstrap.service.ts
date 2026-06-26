import "server-only";

import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

/**
 * Idempotent bootstrap of the initial owner (ADR / target provisioning model).
 * Seeds an owner user, a workspace for the configured Azure org, and an owner
 * membership from BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_AZURE_ORG. A no-op
 * when those env vars are unset; otherwise it is safe to call on every startup
 * and will keep the configured bootstrap identity as an active owner.
 */

export type BootstrapResult = { workspaceId: string; userId: string } | null;

export async function ensureBootstrapOwner(): Promise<BootstrapResult> {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL?.trim();
  const orgInput = process.env.BOOTSTRAP_OWNER_AZURE_ORG?.trim();
  if (!email || !orgInput) return null;

  const { name: orgName, url: orgUrl } = normalizeAzureOrg(orgInput);
  const now = nowIso();

  await sqlRun(
    `INSERT INTO workspaces (id, name, azure_org_name, azure_org_url, status, created_at, updated_at)
     VALUES (@id, @name, @orgName, @orgUrl, 'active', @now, @now)
     ON CONFLICT (azure_org_url) DO NOTHING`,
    { id: createId("ws"), name: orgName, orgName, orgUrl, now },
  );
  const workspace = await sqlGet<{ id: string }>(
    `SELECT id FROM workspaces WHERE azure_org_url = @orgUrl LIMIT 1`,
    { orgUrl },
  );
  if (!workspace) throw new Error("Bootstrap failed to resolve workspace.");

  await sqlRun(
    `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
     VALUES (@id, @displayName, @email, 'active', @now)
     ON CONFLICT (email_or_unique_name) DO NOTHING`,
    { id: createId("user"), displayName: email, email, now },
  );
  const user = await sqlGet<{ id: string }>(
    `SELECT id FROM users WHERE email_or_unique_name = @email LIMIT 1`,
    { email },
  );
  if (!user) throw new Error("Bootstrap failed to resolve owner user.");

  await sqlRun(
    `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
     VALUES (@id, @workspaceId, @userId, 'owner', 'active', @now, @now)
     ON CONFLICT (workspace_id, user_id)
     DO UPDATE SET role = 'owner', status = 'active', updated_at = @now
     WHERE workspace_members.role <> 'owner' OR workspace_members.status <> 'active'`,
    { id: createId("wm"), workspaceId: workspace.id, userId: user.id, now },
  );

  return { workspaceId: workspace.id, userId: user.id };
}

/** Accepts either an org name ("contoso") or a full org URL and normalizes both. */
export function normalizeAzureOrg(input: string): { name: string; url: string } {
  if (/^https?:\/\//i.test(input)) {
    const trimmed = input.replace(/\/+$/, "");
    const name = trimmed.split("/").filter(Boolean).pop() ?? trimmed;
    return { name, url: trimmed };
  }
  return { name: input, url: `https://dev.azure.com/${input}` };
}
