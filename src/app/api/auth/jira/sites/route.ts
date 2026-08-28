import { NextResponse } from "next/server";

import { listActiveJiraSites } from "@/modules/workspace/workspace.service";
import { isLoginProviderEnabled } from "@/modules/auth/enabled-providers";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";

export const runtime = "nodejs";

/**
 * Pre-auth Jira site picker for the login page — the Jira mirror of
 * /api/auth/organizations. Display fields only (never internal workspace ids
 * or Atlassian cloudIds). The picker is convenience: the OAuth start route
 * re-validates the chosen site and the callback verifies the authenticated
 * account can actually access it. Lightly rate-limited per IP.
 */
export async function GET(request: Request) {
  const rate = await checkRateLimit(`jirasitelist:${clientIp(request)}`, 60, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  if (!await isLoginProviderEnabled("jira-cloud")) {
    return NextResponse.json({ error: "Jira Cloud sign-in is disabled for this deployment." }, { status: 403 });
  }

  const sites = await listActiveJiraSites();
  return NextResponse.json({ sites }, { headers: { "Cache-Control": "no-store" } });
}
