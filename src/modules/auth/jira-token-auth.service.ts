import "server-only";

import { z } from "zod";

import { jiraApiBase, jiraBasicAuthorization, type JiraTokenKind } from "@/modules/integrations/jira-cloud/jira-http";
import { normalizeJiraSite } from "./bootstrap.service";

export type { JiraTokenKind };

/** The configured site a login is bound to, with its pinned-to-be cloud ID. */
export type JiraSiteResource = { cloudId: string; siteName: string; siteUrl: string };

/**
 * The provisioning identity contract: `accountId` is the stable provider
 * subject; `emailAddress` is ALWAYS the normalized email the user typed,
 * verified because Atlassian rejects a mismatched email:token pair — and
 * cross-checked against /myself when profile visibility exposes it.
 */
export type JiraUserIdentity = { accountId: string; displayName: string; emailAddress: string };

export class JiraTokenAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraTokenAuthError";
  }
}

export class InvalidJiraTokenError extends JiraTokenAuthError {
  constructor() {
    super("Atlassian rejected this email and API token. Check both and try again.");
    this.name = "InvalidJiraTokenError";
  }
}

export class JiraTokenScopeError extends JiraTokenAuthError {
  constructor() {
    super("The API token is valid but is missing required scopes. Create a token with the read:jira-work, write:jira-work, and read:jira-user scopes.");
    this.name = "JiraTokenScopeError";
  }
}

const TenantInfoSchema = z.object({ cloudId: z.string().min(1) });
const MyselfSchema = z.object({
  accountId: z.string().min(1),
  displayName: z.string().min(1).optional(),
  emailAddress: z.string().email().nullish(),
});
type MyselfUser = z.infer<typeof MyselfSchema>;

/**
 * Resolve a configured site's stable Atlassian cloud ID via the unauthenticated
 * tenant endpoint. MUST be called with the operator-validated site URL — the
 * same host Basic auth will run against — so the pinned cloud ID can never be
 * poisoned by caller-supplied input.
 */
export async function resolveJiraSiteResource(siteUrl: string): Promise<JiraSiteResource> {
  const site = normalizeJiraSite(siteUrl);
  let response: Response;
  try {
    response = await fetch(`${site.url}/_edge/tenant_info`, { cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    throw new JiraTokenAuthError("The Jira site is unreachable. Try again later.");
  }
  if (!response.ok) throw new JiraTokenAuthError("The Jira site identity could not be resolved. Try again later.");
  const parsed = TenantInfoSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new JiraTokenAuthError("The Jira site returned an invalid identity response.");
  return { cloudId: parsed.data.cloudId, siteName: site.name, siteUrl: site.url };
}

/**
 * Validate an email + API token pair against the site and detect the token
 * kind: the api.atlassian.com gateway (scoped tokens) is probed first, the
 * direct site URL (classic tokens) second — the two kinds are URL-exclusive,
 * so the successful probe identifies the kind. Both probes failing auth means
 * the pair is invalid; a scope-signature rejection is reported distinctly so a
 * mis-scoped token is never diagnosed as a wrong password.
 */
export async function authenticateJiraApiToken(input: {
  resource: JiraSiteResource;
  emailAddress: string;
  apiToken: string;
}): Promise<{ identity: JiraUserIdentity; tokenKind: JiraTokenKind }> {
  const email = input.emailAddress.trim().toLowerCase();
  if (!email || !input.apiToken.trim()) throw new InvalidJiraTokenError();
  const auth = { email, apiToken: input.apiToken };

  const gateway = await probeMyself(
    `${jiraApiBase({ tokenKind: "scoped", cloudId: input.resource.cloudId, siteUrl: input.resource.siteUrl })}/myself`,
    auth,
  );
  if (gateway.outcome === "ok") return { identity: verifiedIdentity(gateway.user, email), tokenKind: "scoped" };
  if (gateway.outcome === "scope") throw new JiraTokenScopeError();
  if (gateway.outcome === "unavailable") throw new JiraTokenAuthError("Atlassian is unavailable. Try again later.");

  const site = await probeMyself(
    `${jiraApiBase({ tokenKind: "classic", cloudId: input.resource.cloudId, siteUrl: input.resource.siteUrl })}/myself`,
    auth,
  );
  if (site.outcome === "ok") return { identity: verifiedIdentity(site.user, email), tokenKind: "classic" };
  if (site.outcome === "scope") throw new JiraTokenScopeError();
  if (site.outcome === "unavailable") throw new JiraTokenAuthError("Atlassian is unavailable. Try again later.");
  throw new InvalidJiraTokenError();
}

type ProbeResult =
  | { outcome: "ok"; user: MyselfUser }
  | { outcome: "denied" }
  | { outcome: "scope" }
  | { outcome: "unavailable" };

async function probeMyself(url: string, auth: { email: string; apiToken: string }): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: { Authorization: jiraBasicAuthorization(auth), Accept: "application/json" },
    });
  } catch {
    return { outcome: "unavailable" };
  }
  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    return /scope/i.test(body) ? { outcome: "scope" } : { outcome: "denied" };
  }
  if (!response.ok) return { outcome: "unavailable" };
  const parsed = MyselfSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { outcome: "unavailable" };
  return { outcome: "ok", user: parsed.data };
}

function verifiedIdentity(user: MyselfUser, email: string): JiraUserIdentity {
  if (user.emailAddress && user.emailAddress.trim().toLowerCase() !== email) {
    throw new InvalidJiraTokenError();
  }
  return { accountId: user.accountId, displayName: user.displayName?.trim() || email, emailAddress: email };
}
