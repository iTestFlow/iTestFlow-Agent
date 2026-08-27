import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";

import { buildAtlassianAuthorizationUrl } from "@/modules/auth/jira-oauth";
import { createJiraOAuthState } from "@/modules/auth/jira-oauth-state";
import { JIRA_OAUTH_BINDING_COOKIE } from "@/modules/auth/jira-oauth-cookie";
import { isLoginProviderEnabled } from "@/modules/auth/enabled-providers";
import { normalizeJiraSite } from "@/modules/auth/bootstrap.service";
import { findActiveJiraSiteByUrl } from "@/modules/workspace/workspace.service";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const rate = await checkRateLimit(`jira-oauth-start:${clientIp(request)}`, 10, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many Jira connection attempts. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }
  if (!isLoginProviderEnabled("jira-cloud")) {
    return NextResponse.json({ error: "Jira Cloud sign-in is disabled for this deployment." }, { status: 403 });
  }
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo") ?? "/dashboards";

  // Site-before-OAuth: the login page passes the site the user chose so the
  // callback can verify grant access to exactly that site. The picker is
  // deployment-scoped, mirroring the Azure org rule: only an enabled (seeded
  // or already-connected) active site is accepted. Omitted `site` keeps the
  // legacy post-callback selection flow.
  let selectedWorkspace: { workspaceId: string; siteUrl: string } | null = null;
  const siteParam = url.searchParams.get("site")?.trim();
  if (siteParam) {
    let normalized: { name: string; url: string };
    try {
      normalized = normalizeJiraSite(siteParam);
    } catch {
      return NextResponse.json({ error: "The requested Jira site is not valid." }, { status: 400 });
    }
    const site = await findActiveJiraSiteByUrl(normalized.url);
    if (!site) {
      return NextResponse.json(
        { error: "This Jira Cloud site is not enabled for iTestFlow. Ask your administrator to add it to BOOTSTRAP_JIRA_SITES." },
        { status: 403 },
      );
    }
    selectedWorkspace = { workspaceId: site.workspaceId, siteUrl: site.siteUrl };
  }

  const browserBinding = randomBytes(32).toString("base64url");
  const state = await createJiraOAuthState(returnTo, browserBinding, selectedWorkspace);
  (await cookies()).set(JIRA_OAUTH_BINDING_COOKIE, browserBinding, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return NextResponse.redirect(buildAtlassianAuthorizationUrl(state));
}
