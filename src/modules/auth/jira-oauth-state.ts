import "server-only";

import { createHash, randomBytes } from "crypto";

import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

/**
 * CSRF state for the Jira OAuth login, restored from the pre-67a111dc era
 * with the site-before-OAuth flow now mandatory: every state row binds the
 * operator-configured workspace, its canonical site URL, and the pinned cloud
 * ID known at start time (nullable — a bootstrap-seeded workspace adopts its
 * pin on first login). Only hashes of the state and the browser-binding
 * cookie are persisted; consumption is single-use via DELETE ... RETURNING
 * under a 10-minute TTL, and it survives restarts — which is why the routes
 * re-check enablement mid-flight.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

export class JiraOAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraOAuthStateError";
  }
}

export type JiraOAuthSiteSelection = {
  workspaceId: string;
  siteUrl: string;
  cloudId: string | null;
};

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function safeReturnTo(returnTo: string): string {
  const value = returnTo.trim();
  const encodedPathSeparator = /%(?:2f|5c)/i;
  let resolved: URL | null = null;
  try {
    resolved = new URL(value, "https://itestflow.invalid");
  } catch {
    // Handled by the shared rejection below.
  }
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    encodedPathSeparator.test(value) ||
    resolved?.origin !== "https://itestflow.invalid"
  ) {
    throw new JiraOAuthStateError("Jira OAuth return destination must be a local path.");
  }
  return value;
}

export async function createJiraOAuthState(
  returnTo: string,
  browserBinding: string,
  selection: JiraOAuthSiteSelection,
): Promise<string> {
  const destination = safeReturnTo(returnTo);
  if (!browserBinding.trim()) throw new JiraOAuthStateError("Jira OAuth browser binding is required.");
  const selectedWorkspaceId = selection.workspaceId.trim();
  const selectedSiteUrl = selection.siteUrl.trim();
  if (!selectedWorkspaceId || !selectedSiteUrl) {
    throw new JiraOAuthStateError("Jira OAuth site selection is incomplete.");
  }
  const state = randomBytes(32).toString("base64url");
  const now = nowIso();
  const expiresAt = new Date(Date.parse(now) + STATE_TTL_MS).toISOString();
  await sqlRun(
    `WITH expired_states AS (
       DELETE FROM jira_oauth_states
       WHERE expires_at <= @now
       RETURNING id
     )
     INSERT INTO jira_oauth_states (
       id, state_hash, browser_binding_hash, return_to,
       selected_workspace_id, selected_site_url, selected_cloud_id, created_at, expires_at
     ) VALUES (
       @id, @stateHash, @browserBindingHash, @returnTo,
       @selectedWorkspaceId, @selectedSiteUrl, @selectedCloudId, @now, @expiresAt
     )`,
    {
      id: createId("oauthstate"), stateHash: hashState(state), browserBindingHash: hashState(browserBinding),
      returnTo: destination, selectedWorkspaceId, selectedSiteUrl,
      selectedCloudId: selection.cloudId?.trim() || null, now, expiresAt,
    },
  );
  return state;
}

export async function consumeJiraOAuthState(
  state: string,
  browserBinding: string,
): Promise<{ returnTo: string; selectedWorkspaceId: string; selectedSiteUrl: string; selectedCloudId: string | null }> {
  if (!state.trim() || !browserBinding.trim()) throw new JiraOAuthStateError("Jira OAuth state and browser binding are required.");
  const row = await sqlGet<{
    return_to: string;
    selected_workspace_id: string;
    selected_site_url: string;
    selected_cloud_id: string | null;
  }>(
    `DELETE FROM jira_oauth_states
     WHERE state_hash = @stateHash AND browser_binding_hash = @browserBindingHash AND expires_at > @now
     RETURNING return_to, selected_workspace_id, selected_site_url, selected_cloud_id`,
    { stateHash: hashState(state), browserBindingHash: hashState(browserBinding), now: nowIso() },
  );
  if (!row) throw new JiraOAuthStateError("Jira OAuth state is invalid, expired, or already used.");
  return {
    returnTo: safeReturnTo(row.return_to),
    selectedWorkspaceId: row.selected_workspace_id,
    selectedSiteUrl: row.selected_site_url,
    selectedCloudId: row.selected_cloud_id ?? null,
  };
}
