import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";

import { buildAtlassianAuthorizationUrl } from "@/modules/auth/jira-oauth";
import { createJiraOAuthState, JiraOAuthStateError } from "@/modules/auth/jira-oauth-state";
import { JIRA_OAUTH_BINDING_COOKIE } from "@/modules/auth/jira-oauth-cookie";
import { isJiraLoginMethodEnabled } from "@/modules/auth/enabled-providers";
import { normalizeJiraSite } from "@/modules/auth/bootstrap.service";
import { findActiveJiraSiteByUrl } from "@/modules/workspace/workspace.service";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";

export const runtime = "nodejs";

/**
 * Jira sign-in with Atlassian OAuth, step 1 of 2. Gate order: rate limit →
 * oauth method enabled (fail-closed) → mandatory site validation against the
 * operator-configured trust anchors (site-before-OAuth: the callback verifies
 * the grant covers exactly this site and never silently switches) → CSRF
 * state bound to the browser via a short-lived HttpOnly cookie → redirect to
 * Atlassian. Credentials never touch this route; errors never echo an
 * unlisted site.
 */
export async function GET(request: Request): Promise<Response> {
  const rate = await checkRateLimit(`jira-oauth-start:${clientIp(request)}`, 10, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many Jira connection attempts. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }
  if (!await isJiraLoginMethodEnabled("oauth")) {
    return NextResponse.json({ error: "Jira sign-in with Atlassian is disabled for this deployment." }, { status: 403 });
  }

  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/dashboards";
  const siteParam = url.searchParams.get("site")?.trim();
  if (!siteParam) {
    return NextResponse.json({ error: "Select your Jira site before continuing with Atlassian." }, { status: 400 });
  }
  let normalized: { name: string; url: string };
  try {
    normalized = normalizeJiraSite(siteParam);
  } catch {
    return NextResponse.json({ error: "The requested Jira site is not valid." }, { status: 400 });
  }
  const site = await findActiveJiraSiteByUrl(normalized.url);
  if (!site) {
    return NextResponse.json(
      { error: "This Jira site is not enabled for iTestFlow. Ask your administrator to configure it." },
      { status: 403 },
    );
  }

  const browserBinding = randomBytes(32).toString("base64url");
  let state: string;
  try {
    state = await createJiraOAuthState(returnTo, browserBinding, {
      workspaceId: site.workspaceId,
      siteUrl: site.siteUrl,
      cloudId: site.cloudId ?? null,
    });
  } catch (error) {
    if (error instanceof JiraOAuthStateError) {
      return NextResponse.json({ error: "The sign-in return destination is not valid." }, { status: 400 });
    }
    throw error;
  }
  (await cookies()).set(JIRA_OAUTH_BINDING_COOKIE, browserBinding, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return NextResponse.redirect(buildAtlassianAuthorizationUrl(state));
}
