import "server-only";

import { sqlGet } from "@/modules/shared/infrastructure/database/db";
import { parseBootstrapJiraSites } from "./bootstrap.service";

/**
 * Which work-management providers the login surface offers (issue #186).
 *
 * `BOOTSTRAP_ENABLED_PROVIDERS` is an explicit comma-separated list of provider
 * ids, validated fail-fast at startup (see instrumentation-node and the worker
 * entrypoint). When unset, auto-detect keeps Azure DevOps always available and
 * offers Jira Cloud exactly when the deployment has configured Jira sites —
 * parsed bootstrap entries, or (when a database is configured) an active
 * jira-cloud workspace surviving from an earlier seed. NOTE the deliberate
 * asymmetry with Azure: Azure orgs are user-entered at login, while Jira sites
 * are operator-preconfigured trust anchors, so Jira enablement keys on them.
 */

export type LoginProviderId = "azure-devops" | "jira-cloud";

export const LOGIN_PROVIDER_LABELS: Record<LoginProviderId, string> = {
  "azure-devops": "Azure DevOps",
  "jira-cloud": "Jira Cloud",
};

const KNOWN_PROVIDER_IDS: readonly LoginProviderId[] = ["azure-devops", "jira-cloud"];

function isKnownProviderId(value: string): value is LoginProviderId {
  return (KNOWN_PROVIDER_IDS as readonly string[]).includes(value);
}

function configuredProviderList(): LoginProviderId[] {
  const configured = (process.env.BOOTSTRAP_ENABLED_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const result: LoginProviderId[] = [];
  for (const value of configured) {
    if (!isKnownProviderId(value)) {
      throw new Error(
        `BOOTSTRAP_ENABLED_PROVIDERS contains unknown provider "${value}". Allowed values: azure-devops, jira-cloud.`,
      );
    }
    if (!result.includes(value)) result.push(value);
  }
  return result;
}

/** DB-free configuration-shape validation, safe before migrations or without a database. */
export function validateEnabledProviderShape(): void {
  configuredProviderList();
  parseBootstrapJiraSites();
  configuredJiraLoginMethodList();
}

export type JiraLoginMethod = "api_token" | "oauth";

const KNOWN_JIRA_LOGIN_METHODS: readonly JiraLoginMethod[] = ["api_token", "oauth"];

const OAUTH_ENV_KEYS = ["ATLASSIAN_OAUTH_CLIENT_ID", "ATLASSIAN_OAUTH_CLIENT_SECRET", "ATLASSIAN_OAUTH_REDIRECT_URI"] as const;

function isKnownJiraLoginMethod(value: string): value is JiraLoginMethod {
  return (KNOWN_JIRA_LOGIN_METHODS as readonly string[]).includes(value);
}

/** All-or-none: a partial ATLASSIAN_OAUTH_* set is a deployment mistake, named at startup rather than surfacing as broken sign-in buttons. */
function oauthClientConfigured(): boolean {
  const missing = OAUTH_ENV_KEYS.filter((key) => !process.env[key]?.trim());
  if (missing.length === OAUTH_ENV_KEYS.length) return false;
  if (missing.length > 0) {
    throw new Error(
      `The Atlassian OAuth client is partially configured; missing ${missing.join(", ")}. Set all of ${OAUTH_ENV_KEYS.join(", ")} or none.`,
    );
  }
  return true;
}

/**
 * Which Jira sign-in methods this deployment offers (before the provider-level
 * gate). `JIRA_LOGIN_METHODS` is an explicit comma-separated list from
 * {api_token, oauth}, order preserved (it drives the login pane's default);
 * unset keeps the auto rule — api_token always, oauth exactly when the OAuth
 * client is fully configured — so a deployment with no OAuth env is
 * byte-identical to the token-only era. OAuth-only mode (`oauth` alone) is the
 * escape hatch for orgs whose Atlassian policy blocks API tokens.
 */
function configuredJiraLoginMethodList(): JiraLoginMethod[] {
  const oauthConfigured = oauthClientConfigured();
  const raw = process.env.JIRA_LOGIN_METHODS?.trim();
  if (!raw) return oauthConfigured ? ["api_token", "oauth"] : ["api_token"];
  const entries = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error("JIRA_LOGIN_METHODS is set but lists no method. Allowed values: api_token, oauth.");
  }
  const result: JiraLoginMethod[] = [];
  for (const value of entries) {
    if (!isKnownJiraLoginMethod(value)) {
      throw new Error(`JIRA_LOGIN_METHODS contains unknown method "${value}". Allowed values: api_token, oauth.`);
    }
    if (!result.includes(value)) result.push(value);
  }
  if (result.includes("oauth") && !oauthConfigured) {
    throw new Error(
      "JIRA_LOGIN_METHODS enables oauth, but the Atlassian OAuth client is not configured. Set ATLASSIAN_OAUTH_CLIENT_ID, ATLASSIAN_OAUTH_CLIENT_SECRET, and ATLASSIAN_OAUTH_REDIRECT_URI.",
    );
  }
  return result;
}

/**
 * Enabled Jira sign-in methods in display order, [] when the jira-cloud
 * provider itself is disabled. Callers that already resolved the provider
 * list pass it in, so provider and method state come from one snapshot.
 * Fails closed to [] on request-time resolution errors — startup already
 * failed fast on configuration mistakes, and a public route hitting
 * post-boot drift must see "disabled", never a 500.
 */
export async function getEnabledJiraLoginMethods(enabledProviders?: readonly LoginProviderId[]): Promise<JiraLoginMethod[]> {
  try {
    const providers = enabledProviders ?? await getEnabledLoginProviders();
    if (!providers.includes("jira-cloud")) return [];
    return configuredJiraLoginMethodList();
  } catch {
    return [];
  }
}

export async function isJiraLoginMethodEnabled(method: JiraLoginMethod): Promise<boolean> {
  return (await getEnabledJiraLoginMethods()).includes(method);
}

async function jiraSitesConfigured(): Promise<boolean> {
  if (parseBootstrapJiraSites().length > 0) return true;
  // Bootstrap is additive and DB-persistent: a deployment that seeded sites and
  // later trimmed its env must not silently lose its Jira login. DB-less
  // contexts (no DATABASE_URL) stay env-keyed.
  if (!process.env.DATABASE_URL) return false;
  const row = await sqlGet<{ configured: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM workspaces WHERE provider_id = 'jira-cloud' AND status = 'active') AS configured`,
  );
  return row?.configured ?? false;
}

/**
 * Enabled providers in display order. Explicit configuration preserves the
 * operator's order (it drives the login page's default pane) and throws on an
 * unknown id or on enabling jira-cloud with no configured Jira site — both
 * would otherwise surface as broken sign-in buttons at runtime.
 */
export async function getEnabledLoginProviders(): Promise<LoginProviderId[]> {
  const configured = configuredProviderList();
  if (configured.length === 0) {
    return await jiraSitesConfigured() ? ["azure-devops", "jira-cloud"] : ["azure-devops"];
  }
  if (configured.includes("jira-cloud") && !await jiraSitesConfigured()) {
    throw new Error(
      "BOOTSTRAP_ENABLED_PROVIDERS enables jira-cloud, but no Jira site is configured. Set BOOTSTRAP_JIRA_SITES (or BOOTSTRAP_OWNER_JIRA_SITE with BOOTSTRAP_OWNER_EMAIL).",
    );
  }
  return configured;
}

export async function isLoginProviderEnabled(id: LoginProviderId): Promise<boolean> {
  try {
    return (await getEnabledLoginProviders()).includes(id);
  } catch {
    // Startup already failed fast on configuration errors; a request-time
    // failure here (database outage, enablement drift after boot) fails closed
    // as "disabled" instead of turning a public pre-auth route into a 500.
    return false;
  }
}
