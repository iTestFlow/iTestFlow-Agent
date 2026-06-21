import { NextResponse } from "next/server";
import { z } from "zod";

import { nowIso } from "@/modules/shared/infrastructure/database/db";
import { PatAuthProvider } from "@/modules/auth/pat-auth-provider";
import { storeWorkspaceSyncPat } from "@/modules/credentials/credential.service";
import { resolveWorkspaceRequest, workspaceRequestError } from "@/modules/workspace/workspace-request";
import { checkRateLimit, clientIp } from "@/modules/security/rate-limit";

export const runtime = "nodejs";

const Schema = z.object({ personalAccessToken: z.string().trim().min(1, "Enter a Personal Access Token.") });

/**
 * Sets the workspace sync credential (owner/admin only) — a service-account /
 * admin PAT the worker uses for scheduled sync, separate from any user's
 * interactive PAT. Validated against the workspace's Azure org before storing;
 * stored encrypted and never returned.
 */
export async function POST(request: Request) {
  const rate = checkRateLimit(`sync-cred:${clientIp(request)}`, 10, 5 * 60 * 1000);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait and try again." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } },
    );
  }

  let context;
  try {
    context = await resolveWorkspaceRequest(["owner", "admin"]);
  } catch (error) {
    const response = workspaceRequestError(error);
    if (response) return response;
    throw error;
  }

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  }

  try {
    await new PatAuthProvider().authenticate({
      organizationUrl: context.workspace.azureOrgUrl,
      personalAccessToken: parsed.data.personalAccessToken,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps PAT validation failed." },
      { status: 422 },
    );
  }

  await storeWorkspaceSyncPat({
    workspaceId: context.workspace.id,
    pat: parsed.data.personalAccessToken,
    createdByUserId: context.userId,
    lastValidatedAt: nowIso(),
  });

  return NextResponse.json({ ok: true, workspaceId: context.workspace.id });
}
