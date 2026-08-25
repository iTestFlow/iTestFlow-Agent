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

export type BootstrapJiraSiteEntry = { siteName: string; siteUrl: string; email: string };

export async function ensureBootstrapOwner(): Promise<BootstrapResult> {
  // Parse every provider before any DB write so one misconfigured entry fails
  // fast with nothing half-seeded.
  const azureEntries = parseBootstrapOrgs();
  const jiraEntries = parseBootstrapJiraSites();
  if (azureEntries.length === 0 && jiraEntries.length === 0) return null;

  const now = nowIso();
  let first: BootstrapResult = null;

  for (const entry of azureEntries) {
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

  for (const entry of jiraEntries) {
    const workspaceId = await ensureJiraSiteWorkspace(entry, now);
    const userId = await ensureJiraOwnerUser(entry.email, now);
    await sqlRun(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status, created_at, updated_at)
       VALUES (@id, @workspaceId, @userId, 'owner', 'active', @now, @now)
       ON CONFLICT (workspace_id, user_id)
       DO UPDATE SET role = 'owner', status = 'active', updated_at = @now
       WHERE workspace_members.role <> 'owner' OR workspace_members.status <> 'active'`,
      { id: createId("wm"), workspaceId, userId, now },
    );
    if (!first) first = { workspaceId, userId };
  }

  return first;
}

/**
 * Adopt-or-seed the workspace row for a configured Jira site. Seeded rows carry
 * the normalized site URL with a NULL provider_site_id — the Atlassian cloudId
 * is only learnable after the first OAuth grant, at which point
 * provisionJiraLogin claims the row (see jira-provisioning.service). Adoption
 * matches by URL so a site that already connected via OAuth is never
 * duplicated, and an existing row never has its status flipped here
 * (soft-disable stays authoritative, matching the Azure org behavior).
 */
async function ensureJiraSiteWorkspace(entry: BootstrapJiraSiteEntry, now: string): Promise<string> {
  const existing = await sqlGet<{ id: string }>(
    `SELECT id FROM workspaces
     WHERE provider_id = 'jira-cloud' AND provider_site_url = @siteUrl
     LIMIT 1`,
    { siteUrl: entry.siteUrl },
  );
  if (existing) return existing.id;

  // Bare ON CONFLICT: both the (provider_id, provider_site_id) and the
  // (provider_id, provider_site_url) partial unique indexes may arbitrate.
  await sqlRun(
    `INSERT INTO workspaces (
       id, name, azure_org_name, azure_org_url, provider_id,
       provider_site_id, provider_site_name, provider_site_url, status, created_at, updated_at
     ) VALUES (
       @id, @name, NULL, NULL, 'jira-cloud',
       NULL, @siteName, @siteUrl, 'active', @now, @now
     )
     ON CONFLICT DO NOTHING`,
    { id: createId("ws"), name: entry.siteName, siteName: entry.siteName, siteUrl: entry.siteUrl, now },
  );
  const workspace = await sqlGet<{ id: string }>(
    `SELECT id FROM workspaces
     WHERE provider_id = 'jira-cloud' AND provider_site_url = @siteUrl
     LIMIT 1`,
    { siteUrl: entry.siteUrl },
  );
  if (!workspace) throw new Error("Bootstrap failed to resolve Jira site workspace.");
  return workspace.id;
}

/**
 * The idx_users_email_ci invariant forbids inserting a case-variant of an
 * existing email, so resolve case-insensitively first (matching the OAuth
 * email-linking in provisionJiraLogin) before a conflict-tolerant insert.
 */
async function ensureJiraOwnerUser(email: string, now: string): Promise<string> {
  const existing = await sqlGet<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(email_or_unique_name) = LOWER(@email) LIMIT 1`,
    { email },
  );
  if (existing) return existing.id;

  await sqlRun(
    `INSERT INTO users (id, display_name, email_or_unique_name, status, created_at)
     VALUES (@id, @displayName, @email, 'active', @now)
     ON CONFLICT DO NOTHING`,
    { id: createId("user"), displayName: email, email, now },
  );
  const user = await sqlGet<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(email_or_unique_name) = LOWER(@email) LIMIT 1`,
    { email },
  );
  if (!user) throw new Error("Bootstrap failed to resolve owner user.");
  return user.id;
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

/**
 * Parses the configured Jira sites into normalized, de-duplicated owner entries —
 * the Jira mirror of {@link parseBootstrapOrgs}. Runs entirely before any DB
 * write so a misconfigured entry fails fast with nothing half-seeded. The legacy
 * single-site pair (when both vars are set) is kept first. The owner email must
 * match the owner's Atlassian account email (case-insensitive) so the seeded
 * user reconciles in place on their first OAuth login (see provisionJiraLogin).
 */
export function parseBootstrapJiraSites(): BootstrapJiraSiteEntry[] {
  const defaultEmail = process.env.BOOTSTRAP_OWNER_EMAIL?.trim() ?? "";
  const raw: Array<{ siteInput: string; email: string }> = [];

  // Legacy single-site pair — only when BOTH vars are set, matching the Azure
  // pair's "no-op unless both configured" behavior.
  const legacySite = process.env.BOOTSTRAP_OWNER_JIRA_SITE?.trim();
  if (legacySite && defaultEmail) raw.push({ siteInput: legacySite, email: defaultEmail });

  // BOOTSTRAP_JIRA_SITES: comma-separated `site|email`; email optional (inherits BOOTSTRAP_OWNER_EMAIL).
  const list = process.env.BOOTSTRAP_JIRA_SITES?.trim();
  if (list) {
    for (const part of list.split(",")) {
      const entry = part.trim();
      if (!entry) continue;
      const sep = entry.indexOf("|");
      const siteInput = (sep === -1 ? entry : entry.slice(0, sep)).trim();
      const email = (sep === -1 ? "" : entry.slice(sep + 1)).trim() || defaultEmail;
      if (!siteInput) continue;
      raw.push({ siteInput, email });
    }
  }

  const seen = new Set<string>();
  const result: BootstrapJiraSiteEntry[] = [];
  for (const item of raw) {
    const { name, url } = normalizeJiraSite(item.siteInput);
    if (seen.has(url)) continue; // first owner wins for a duplicated site
    if (!item.email) {
      throw new Error(
        `Bootstrap Jira site "${item.siteInput}" has no owner email. Use "site|email" in BOOTSTRAP_JIRA_SITES, or set BOOTSTRAP_OWNER_EMAIL.`,
      );
    }
    seen.add(url);
    result.push({ siteName: name, siteUrl: url, email: item.email });
  }
  return result;
}

/**
 * Accepts a bare site name ("mysite"), a bare host ("mysite.atlassian.net"), or
 * a full https URL, and normalizes all three to the canonical lowercase site
 * URL without a trailing slash. Only *.atlassian.net hosts are valid.
 */
export function normalizeJiraSite(input: string): { name: string; url: string } {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Jira site is empty.");

  let host = trimmed;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    if (!/^https:\/\//i.test(trimmed)) {
      throw new Error(`Jira site "${input}" must use https.`);
    }
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Jira site "${input}" is not a valid URL.`);
    }
    if ((parsed.pathname !== "/" && parsed.pathname !== "") || parsed.search || parsed.hash || parsed.port) {
      throw new Error(
        `Jira site "${input}" must be a bare *.atlassian.net site URL without a path, query, or port.`,
      );
    }
    host = parsed.hostname;
  }

  host = host.toLowerCase().replace(/\/+$/, "");
  if (!host.includes(".")) host = `${host}.atlassian.net`;
  const match = /^([a-z0-9][a-z0-9-]*)\.atlassian\.net$/.exec(host);
  if (!match) {
    throw new Error(
      `Jira site "${input}" must be a *.atlassian.net site (e.g. "mysite" or https://mysite.atlassian.net).`,
    );
  }
  return { name: match[1], url: `https://${host}` };
}
