import { NextResponse } from "next/server";
import { z } from "zod";

import { isLoginProviderEnabled } from "@/modules/auth/enabled-providers";
import { normalizeJiraSite } from "@/modules/auth/bootstrap.service";
import { storeJiraConnection } from "@/modules/auth/jira-connection.service";
import { provisionJiraLogin, JiraSiteNotConfiguredError } from "@/modules/auth/jira-provisioning.service";
import {
  authenticateJiraApiToken,
  InvalidJiraTokenError,
  JiraTokenAuthError,
  JiraTokenScopeError,
  resolveJiraSiteResource,
} from "@/modules/auth/jira-token-auth.service";
import { createSession } from "@/modules/auth/session.service";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { isCrossOriginRequest } from "@/modules/security/origin";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import { findActiveJiraSiteByUrl } from "@/modules/workspace/workspace.service";

export const runtime = "nodejs";

const UNCONFIGURED_SITE_ERROR = "This Jira site is not enabled for iTestFlow. Ask your administrator to configure it.";

const LoginSchema = z.object({
  siteUrl: z.string().trim().min(1, "Select your Jira site."),
  emailAddress: z.string().trim().min(1, "Enter your Atlassian account email.").email("Enter a valid Atlassian account email."),
  apiToken: z.string().trim().min(1, "Enter your Atlassian API token."),
});

/**
 * Jira sign-in with a per-user Atlassian API token — the Jira mirror of the
 * Azure PAT login. Gate order: rate limit → origin → provider enabled →
 * schema → configured-site fail-closed lookup (credentials never leave this
 * server for an unconfigured site) → tenant_info cloud-ID resolution →
 * Basic-auth validation → provisioning → encrypted storage → session. Only an
 * opaque session cookie reaches the browser — never the token. Errors never
 * echo an unlisted site or any part of the credential pair.
 */
export async function POST(request: Request) {
  const rate = await checkRateLimit(`login:${clientIp(request)}`, 10, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  if (isCrossOriginRequest(request)) {
    return NextResponse.json({ error: "Cross-origin sign-in requests are not allowed." }, { status: 403 });
  }

  if (!await isLoginProviderEnabled("jira-cloud")) {
    return NextResponse.json({ error: "Jira Cloud sign-in is disabled for this deployment." }, { status: 403 });
  }

  const parsed = LoginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid login request." }, { status: 400 });
  }

  let normalizedUrl: string;
  try {
    normalizedUrl = normalizeJiraSite(parsed.data.siteUrl).url;
  } catch {
    return NextResponse.json({ error: "Enter a valid *.atlassian.net Jira site." }, { status: 400 });
  }
  const site = await findActiveJiraSiteByUrl(normalizedUrl);
  if (!site) {
    return NextResponse.json({ error: UNCONFIGURED_SITE_ERROR }, { status: 403 });
  }

  try {
    const resource = await resolveJiraSiteResource(normalizedUrl);
    if (site.cloudId && site.cloudId !== resource.cloudId) {
      // The typed URL now belongs to a different Atlassian site than the one
      // this workspace is pinned to (e.g. a freed URL was re-registered).
      return NextResponse.json({ error: UNCONFIGURED_SITE_ERROR }, { status: 403 });
    }
    const { identity, tokenKind } = await authenticateJiraApiToken({
      resource,
      emailAddress: parsed.data.emailAddress,
      apiToken: parsed.data.apiToken,
    });
    const provisioned = await provisionJiraLogin({ resource, identity });
    await storeJiraConnection({
      workspaceId: provisioned.workspaceId,
      userId: provisioned.userId,
      cloudId: resource.cloudId,
      email: identity.emailAddress,
      apiToken: parsed.data.apiToken,
      tokenKind,
      isSyncPrincipal: provisioned.role === "owner",
    });
    await createSession({
      userId: provisioned.userId,
      workspaceId: provisioned.workspaceId,
      userAgent: request.headers.get("user-agent"),
    });
    writeAuditLog({
      workspaceId: provisioned.workspaceId,
      action: "USER_LOGIN",
      status: "Success",
      actor: provisioned.userId,
      message: "Signed in to a Jira Cloud workspace with an Atlassian API token.",
    });
    return NextResponse.json({ ok: true, userId: provisioned.userId, workspaceId: provisioned.workspaceId });
  } catch (error) {
    if (error instanceof JiraTokenScopeError || error instanceof InvalidJiraTokenError) {
      return routeErrorResponse(error, { domain: "auth", status: 401, fallback: error.message });
    }
    if (error instanceof JiraTokenAuthError) {
      return routeErrorResponse(error, { domain: "auth", status: 503, fallback: error.message });
    }
    if (error instanceof JiraSiteNotConfiguredError) {
      return NextResponse.json({ error: UNCONFIGURED_SITE_ERROR }, { status: 403 });
    }
    return NextResponse.json({ error: "Jira sign-in could not be completed. Try again later." }, { status: 500 });
  }
}
