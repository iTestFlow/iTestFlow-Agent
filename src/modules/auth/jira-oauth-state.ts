import "server-only";

import { createHash, randomBytes } from "crypto";

import { createId, nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";

const STATE_TTL_MS = 10 * 60 * 1000;

export class JiraOAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraOAuthStateError";
  }
}

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

export async function createJiraOAuthState(returnTo: string, browserBinding: string): Promise<string> {
  const destination = safeReturnTo(returnTo);
  if (!browserBinding.trim()) throw new JiraOAuthStateError("Jira OAuth browser binding is required.");
  const state = randomBytes(32).toString("base64url");
  const now = nowIso();
  const expiresAt = new Date(Date.parse(now) + STATE_TTL_MS).toISOString();
  await sqlRun(
    `INSERT INTO jira_oauth_states (id, state_hash, browser_binding_hash, return_to, created_at, expires_at)
     VALUES (@id, @stateHash, @browserBindingHash, @returnTo, @now, @expiresAt)`,
    {
      id: createId("oauthstate"), stateHash: hashState(state), browserBindingHash: hashState(browserBinding),
      returnTo: destination, now, expiresAt,
    },
  );
  return state;
}

export async function consumeJiraOAuthState(state: string, browserBinding: string): Promise<{ returnTo: string }> {
  if (!state.trim() || !browserBinding.trim()) throw new JiraOAuthStateError("Jira OAuth state and browser binding are required.");
  const row = await sqlGet<{ return_to: string }>(
    `DELETE FROM jira_oauth_states
     WHERE state_hash = @stateHash AND browser_binding_hash = @browserBindingHash AND expires_at > @now
     RETURNING return_to`,
    { stateHash: hashState(state), browserBindingHash: hashState(browserBinding), now: nowIso() },
  );
  if (!row) throw new JiraOAuthStateError("Jira OAuth state is invalid, expired, or already used.");
  return { returnTo: safeReturnTo(row.return_to) };
}
