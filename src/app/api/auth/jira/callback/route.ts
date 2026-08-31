import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { canonicalJiraSiteUrl } from "@/modules/auth/bootstrap.service";
import { storeJiraConnection } from "@/modules/auth/jira-connection.service";
import {
  AtlassianOAuthError,
  exchangeAtlassianAuthorizationCode,
  getAtlassianUserIdentity,
  listAtlassianAccessibleResources,
} from "@/modules/auth/jira-oauth";
import { consumeJiraOAuthState, JiraOAuthStateError } from "@/modules/auth/jira-oauth-state";
import { JIRA_OAUTH_BINDING_COOKIE } from "@/modules/auth/jira-oauth-cookie";
import { isJiraLoginMethodEnabled } from "@/modules/auth/enabled-providers";
import { provisionJiraLogin } from "@/modules/auth/jira-provisioning.service";
import { createSession } from "@/modules/auth/session.service";
import { findActiveJiraSiteById } from "@/modules/workspace/workspace.service";

export const runtime = "nodejs";

/**
 * Jira sign-in with Atlassian OAuth, step 2 of 2: a top-level browser
 * navigation from auth.atlassian.com, so failures redirect to the login
 * page's error surface instead of answering JSON. The single-use state is
 * consumed against the browser-binding cookie; the state's workspace is
 * re-resolved to its CURRENT site row (a rename or adoption may have landed
 * since start); the grant must cover exactly that site — never silently
 * switch; and the verified /me identity flows through the same provisioning,
 * storage (latest-wins OAuth credential), and session paths as token login.
 * Errors never echo the authorization code, tokens, or an unlisted site.
 */
export async function GET(request: Request): Promise<Response> {
  // Persisted OAuth state survives a restart, so disablement must also close
  // the callback: without this, an in-flight sign-in could still complete for
  // up to the state TTL after the operator disabled the method.
  if (!await isJiraLoginMethodEnabled("oauth")) {
    return NextResponse.json({ error: "Jira sign-in with Atlassian is disabled for this deployment." }, { status: 403 });
  }
  const url = new URL(request.url);
  const loginError = (code: "jira_oauth_state" | "jira_site_access" | "jira_oauth_unavailable" | "jira_oauth_failed", site?: string) => {
    const redirect = new URL("/login", url.origin);
    redirect.searchParams.set("error", code);
    if (site) redirect.searchParams.set("site", site);
    return NextResponse.redirect(redirect);
  };

  const state = url.searchParams.get("state")?.trim();
  const code = url.searchParams.get("code")?.trim();
  if (!state || !code) return loginError("jira_oauth_state");

  try {
    const cookieStore = await cookies();
    const browserBinding = cookieStore.get(JIRA_OAUTH_BINDING_COOKIE)?.value ?? "";
    const consumed = await consumeJiraOAuthState(state, browserBinding);

    const site = await findActiveJiraSiteById(consumed.selectedWorkspaceId);
    if (!site) return loginError("jira_site_access", consumed.selectedSiteUrl);

    const tokens = await exchangeAtlassianAuthorizationCode(code);
    const resources = await listAtlassianAccessibleResources(tokens.accessToken);
    // The user chose this site before OAuth. Verify the authenticated account
    // can access exactly it — by the pinned cloud ID, or by canonical URL for
    // a seeded workspace that adopts its pin on this first login.
    const resource = site.cloudId
      ? resources.find((candidate) => candidate.id === site.cloudId)
      : resources.find((candidate) => canonicalJiraSiteUrl(candidate.url) === consumed.selectedSiteUrl);
    if (!resource) return loginError("jira_site_access", consumed.selectedSiteUrl);

    const identity = await getAtlassianUserIdentity(tokens.accessToken);
    const provisioned = await provisionJiraLogin({
      resource: { cloudId: resource.id, siteName: resource.name, siteUrl: canonicalJiraSiteUrl(resource.url) },
      identity,
    });
    await storeJiraConnection({
      credentialKind: "oauth",
      workspaceId: provisioned.workspaceId,
      userId: provisioned.userId,
      cloudId: resource.id,
      email: identity.emailAddress,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSeconds: tokens.expiresInSeconds,
      isSyncPrincipal: provisioned.role === "owner",
    });
    await createSession({
      workspaceId: provisioned.workspaceId,
      userId: provisioned.userId,
      userAgent: request.headers.get("user-agent"),
    });
    cookieStore.delete(JIRA_OAUTH_BINDING_COOKIE);
    writeAuditLog({
      workspaceId: provisioned.workspaceId,
      action: "USER_LOGIN",
      status: "Success",
      actor: provisioned.userId,
      message: "Signed in to a Jira Cloud workspace with Atlassian OAuth.",
    });
    return NextResponse.redirect(new URL(consumed.returnTo, url.origin));
  } catch (error) {
    if (error instanceof JiraOAuthStateError) return loginError("jira_oauth_state");
    if (error instanceof AtlassianOAuthError) return loginError("jira_oauth_unavailable");
    return loginError("jira_oauth_failed");
  }
}
