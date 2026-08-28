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
  return (await getEnabledLoginProviders()).includes(id);
}
