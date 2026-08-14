import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "crypto";

import { buildAtlassianAuthorizationUrl } from "@/modules/auth/jira-oauth";
import { createJiraOAuthState } from "@/modules/auth/jira-oauth-state";
import { JIRA_OAUTH_BINDING_COOKIE } from "@/modules/auth/jira-oauth-cookie";
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
  const returnTo = new URL(request.url).searchParams.get("returnTo") ?? "/dashboards";
  const browserBinding = randomBytes(32).toString("base64url");
  const state = await createJiraOAuthState(returnTo, browserBinding);
  (await cookies()).set(JIRA_OAUTH_BINDING_COOKIE, browserBinding, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 10 * 60,
  });
  return NextResponse.redirect(buildAtlassianAuthorizationUrl(state));
}
