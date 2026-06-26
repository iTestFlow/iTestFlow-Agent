import { NextResponse } from "next/server";
import { z } from "zod";

import { nowIso } from "@/modules/shared/infrastructure/database/db";
import { PatAuthProvider } from "@/modules/auth/pat-auth-provider";
import { ensureWorkspaceMembership, provisionUserFromIdentity } from "@/modules/auth/user.service";
import { normalizeAzureOrg } from "@/modules/auth/bootstrap.service";
import { createSession } from "@/modules/auth/session.service";
import { findWorkspaceByAzureOrgUrl } from "@/modules/workspace/workspace.service";
import { storeUserAzurePat } from "@/modules/credentials/credential.service";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";
import { writeAuditLog } from "@/modules/audit/audit.service";

export const runtime = "nodejs";

const LoginSchema = z.object({
  organization: z.string().trim().min(1, "Select or enter your Azure DevOps organization."),
  personalAccessToken: z.string().trim().min(1, "Enter your Azure DevOps Personal Access Token."),
});

/**
 * Production login (target auth flow): validate the PAT against the chosen
 * Azure DevOps org, read the Azure identity, auto-provision the user as a
 * workspace member, store the PAT encrypted for (user, workspace), and create a
 * session. Only an opaque session cookie reaches the browser — never the PAT.
 * Auto-provisioning is allowed only for orgs that already have a workspace
 * ("enabled").
 */
export async function POST(request: Request) {
  const rate = await checkRateLimit(`login:${clientIp(request)}`, 10, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  const parsed = LoginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid login request." }, { status: 400 });
  }

  const { url: orgUrl } = normalizeAzureOrg(parsed.data.organization);
  const workspace = await findWorkspaceByAzureOrgUrl(orgUrl);
  if (!workspace) {
    return NextResponse.json(
      { error: "This Azure DevOps organization is not enabled for iTestFlow. Ask a workspace owner to enable it." },
      { status: 403 },
    );
  }

  let identity;
  try {
    identity = await new PatAuthProvider().authenticate({
      organizationUrl: orgUrl,
      personalAccessToken: parsed.data.personalAccessToken,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps authentication failed." },
      { status: 401 },
    );
  }

  const userId = await provisionUserFromIdentity(identity);
  // Policy: open self-provisioning — any user who can authenticate a PAT against an
  // already-enabled org joins as `member`. The enabled Azure org is the trust
  // boundary (owners enable the org; org membership grants workspace membership).
  // This is a deliberate product decision; tighten here if invite-only is required.
  await ensureWorkspaceMembership(workspace.id, userId, "member");
  await storeUserAzurePat({
    workspaceId: workspace.id,
    userId,
    pat: parsed.data.personalAccessToken,
    status: "configured",
    lastValidatedAt: nowIso(),
  });
  await createSession({ userId, workspaceId: workspace.id, userAgent: request.headers.get("user-agent") });

  writeAuditLog({
    workspaceId: workspace.id,
    action: "USER_LOGIN",
    status: "Success",
    actor: userId,
    message: `Signed in to workspace ${workspace.name}.`,
  });

  return NextResponse.json({ ok: true, userId, workspaceId: workspace.id });
}
