import "server-only";

import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

/**
 * Idempotent bootstrap of the configured owners (ADR / target provisioning model).
 *
 * Multi-org: a deployment may enable several Azure orgs, EACH with its own owner,
 * via `BOOTSTRAP_AZURE_ORGS` — a comma-separated list of `orgUrlOrName|ownerEmail`
 * entries. The owner email per entry may be omitted to inherit
 * `BOOTSTRAP_OWNER_EMAIL`. Each entry seeds (1) the owner user (by email), (2) a
 * workspace for the org, and (3) an owner membership linking THAT org's owner to
 * THAT org's workspace — so an owner is never granted rights over orgs they were
 * not assigned. The owner email must match the org's Azure unique name/UPN
 * (case-insensitive) so the seeded user reconciles in-place on first PAT login
 * (see provisionUserFromIdentity).
 *
 * Backward compatible: when `BOOTSTRAP_AZURE_ORGS` is unset, the legacy
 * `BOOTSTRAP_OWNER_EMAIL` + `BOOTSTRAP_OWNER_AZURE_ORG` pair is treated as a
 * single entry — identical to the prior single-org behavior. A no-op when no
 * orgs resolve; safe to call on every startup.
 */

export type BootstrapResult = { workspaceId: string; userId: string } | null;

export type BootstrapOrgEntry = { orgName: string; orgUrl: string; email: string };

export async function ensureBootstrapOwner(): Promise<BootstrapResult> {
  const entries = parseBootstrapOrgs();
  if (entries.length === 0) return null;

  const now = nowIso();
  let first: BootstrapResult = null;

  for (const entry of entries) {
    await sqlRun(
      `INSERT INTO workspaces (id, name, azure_org_name, azure_org_url, status, created_at, updated_at)
       VALUES (@id, @name, @orgName, @orgUrl, 'active', @now, @now)
       ON CONFLICT (azure_org_url) DO NOTHING`,
      { id: createId("ws"), name: entry.orgName, orgName: entry.orgName, orgUrl: entry.orgUrl, now },
    );
    const workspace = await sqlGet<{ id: string }>(
      `SELECT id FROM workspaces WHERE azure_org_url = @orgUrl LIMIT 1`,
      { orgUrl: entry.orgUrl },
    );
    if (!workspace) throw new Error("Bootstrap failed to resolve workspace.");

    await sqlRun(
      `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
       VALUES (@id, @displayName, @email, 'active', @now)
       ON CONFLICT (email_or_unique_name) DO NOTHING`,
      { id: createId("user"), displayName: entry.email, email: entry.email, now },
    );
    const user = await sqlGet<{ id: string }>(
      `SELECT id FROM users WHERE email_or_unique_name = @email LIMIT 1`,
      { email: entry.email },
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

    if (!first) first = { workspaceId: workspace.id, userId: user.id };
  }

  return first;
}

/**
 * Parses the configured orgs into normalized, de-duplicated owner entries. Runs
 * entirely before any DB write so a misconfigured entry fails fast with nothing
 * half-seeded. The legacy single-org pair (when both vars are set) is kept first
 * so its workspace is the deterministic return value of {@link ensureBootstrapOwner}.
 */
export function parseBootstrapOrgs(): BootstrapOrgEntry[] {
  const defaultEmail = process.env.BOOTSTRAP_OWNER_EMAIL?.trim() ?? "";
  const raw: Array<{ orgInput: string; email: string }> = [];

  // Legacy single-org pair — only when BOTH vars are set, matching the prior
  // "no-op unless both configured" behavior (never turns a silent no-op into an error).
  const legacyOrg = process.env.BOOTSTRAP_OWNER_AZURE_ORG?.trim();
  if (legacyOrg && defaultEmail) raw.push({ orgInput: legacyOrg, email: defaultEmail });

  // BOOTSTRAP_AZURE_ORGS: comma-separated `org|email`; email optional (inherits BOOTSTRAP_OWNER_EMAIL).
  const list = process.env.BOOTSTRAP_AZURE_ORGS?.trim();
  if (list) {
    for (const part of list.split(",")) {
      const entry = part.trim();
      if (!entry) continue;
      const sep = entry.indexOf("|");
      const orgInput = (sep === -1 ? entry : entry.slice(0, sep)).trim();
      const email = (sep === -1 ? "" : entry.slice(sep + 1)).trim() || defaultEmail;
      if (!orgInput) continue;
      raw.push({ orgInput, email });
    }
  }

  const seen = new Set<string>();
  const result: BootstrapOrgEntry[] = [];
  for (const item of raw) {
    const { name, url } = normalizeAzureOrg(item.orgInput);
    if (seen.has(url)) continue; // first owner wins for a duplicated org
    if (!item.email) {
      throw new Error(
        `Bootstrap org "${item.orgInput}" has no owner email. Use "org|email" in BOOTSTRAP_AZURE_ORGS, or set BOOTSTRAP_OWNER_EMAIL.`,
      );
    }
    seen.add(url);
    result.push({ orgName: name, orgUrl: url, email: item.email });
  }
  return result;
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
