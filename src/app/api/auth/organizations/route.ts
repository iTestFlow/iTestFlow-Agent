import { NextResponse } from "next/server";

import { listActiveWorkspaces } from "@/modules/workspace/workspace.service";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";

export const runtime = "nodejs";

/**
 * Pre-auth org picker for the login page. Returns the Azure orgs this deployment
 * enables — display fields only (never the internal workspace id). The dropdown
 * is convenience only: the trust boundary stays in the login route, which still
 * validates the PAT against the chosen org and rejects orgs without a workspace.
 * Lightly rate-limited per IP to blunt enumeration.
 */
export async function GET(request: Request) {
  const rate = await checkRateLimit(`orglist:${clientIp(request)}`, 60, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  const organizations = await listActiveWorkspaces();
  return NextResponse.json({ organizations }, { headers: { "Cache-Control": "no-store" } });
}
