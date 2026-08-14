import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { storeJiraConnection } from "@/modules/auth/jira-connection.service";
import {
  AtlassianOAuthError,
  AtlassianReauthorizationRequiredError,
  exchangeAtlassianAuthorizationCode,
  getAtlassianUserIdentity,
  listAllowedAtlassianResources,
} from "@/modules/auth/jira-oauth";
import { consumeJiraOAuthState, JiraOAuthStateError } from "@/modules/auth/jira-oauth-state";
import { JIRA_OAUTH_BINDING_COOKIE } from "@/modules/auth/jira-oauth-cookie";
import { provisionJiraLogin } from "@/modules/auth/jira-provisioning.service";
import { createSession } from "@/modules/auth/session.service";
import { createJiraSiteSelection } from "@/modules/auth/jira-site-selection.service";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state")?.trim();
  const code = url.searchParams.get("code")?.trim();
  if (!state || !code) return NextResponse.json({ error: "Jira OAuth state and code are required." }, { status: 400 });

  try {
    const cookieStore = await cookies();
    const browserBinding = cookieStore.get(JIRA_OAUTH_BINDING_COOKIE)?.value ?? "";
    const { returnTo } = await consumeJiraOAuthState(state, browserBinding);
    const tokens = await exchangeAtlassianAuthorizationCode(code);
    const resources = await listAllowedAtlassianResources(tokens.accessToken);
    if (resources.length === 0) {
      return NextResponse.json(
        { error: "No approved Jira Cloud site is available for this account." },
        { status: 403 },
      );
    }
    if (resources.length > 1) {
      const continuation = await createJiraSiteSelection({
      browserBinding,
      returnTo,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresInSeconds: tokens.expiresInSeconds,
      scopes: tokens.scope,
      resources,
      });
      return NextResponse.redirect(new URL(`/login/jira/select?continuation=${encodeURIComponent(continuation)}`, url.origin));
    }
    const resource = resources[0];
    const identity = await getAtlassianUserIdentity(tokens.accessToken, resource.id);
    const provisioned = await provisionJiraLogin({ resource, identity });
    await storeJiraConnection({
    workspaceId: provisioned.workspaceId,
    userId: provisioned.userId,
    cloudId: resource.id,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresInSeconds: tokens.expiresInSeconds,
    scopes: tokens.scope,
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
    message: `Connected Jira Cloud site ${resource.name}.`,
    });
    return NextResponse.redirect(new URL(returnTo, url.origin));
  } catch (error) {
    if (error instanceof JiraOAuthStateError) {
      return NextResponse.json({ error: "This Jira sign-in link is invalid, expired, or already used." }, { status: 400 });
    }
    if (error instanceof AtlassianReauthorizationRequiredError) {
      return NextResponse.json({ error: "Atlassian authorization must be renewed. Reconnect Jira." }, { status: 401 });
    }
    if (error instanceof AtlassianOAuthError) {
      return NextResponse.json({ error: "Atlassian authorization is unavailable. Try again later." }, { status: 503 });
    }
    return NextResponse.json({ error: "Jira sign-in could not be completed. Try again." }, { status: 500 });
  }
}
