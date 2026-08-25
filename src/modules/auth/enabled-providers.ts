import "server-only";

/**
 * Which work-management providers the login surface offers (issue #186).
 *
 * `BOOTSTRAP_ENABLED_PROVIDERS` is an explicit comma-separated list of provider
 * ids, validated fail-fast at startup (see instrumentation-node). When unset,
 * auto-detect preserves the pre-existing effective behavior: Azure DevOps is
 * always available, and Jira Cloud is available exactly when its OAuth client
 * is configured — so upgrading a deployment without touching `.env` changes
 * nothing.
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

/**
 * Enabled providers in display order. Explicit configuration preserves the
 * operator's order (it drives the login page's default pane) and throws on an
 * unknown id or on enabling jira-cloud without `ATLASSIAN_OAUTH_CLIENT_ID` —
 * both would otherwise surface as broken sign-in buttons at runtime.
 */
export function getEnabledLoginProviders(): LoginProviderId[] {
  const jiraConfigured = Boolean(process.env.ATLASSIAN_OAUTH_CLIENT_ID?.trim());

  const configured = (process.env.BOOTSTRAP_ENABLED_PROVIDERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.length === 0) {
    return jiraConfigured ? ["azure-devops", "jira-cloud"] : ["azure-devops"];
  }

  const result: LoginProviderId[] = [];
  for (const value of configured) {
    if (!isKnownProviderId(value)) {
      throw new Error(
        `BOOTSTRAP_ENABLED_PROVIDERS contains unknown provider "${value}". Allowed values: azure-devops, jira-cloud.`,
      );
    }
    if (!result.includes(value)) result.push(value);
  }
  if (result.includes("jira-cloud") && !jiraConfigured) {
    throw new Error(
      "BOOTSTRAP_ENABLED_PROVIDERS enables jira-cloud, but ATLASSIAN_OAUTH_CLIENT_ID is not configured.",
    );
  }
  return result;
}

export function isLoginProviderEnabled(id: LoginProviderId): boolean {
  return getEnabledLoginProviders().includes(id);
}
