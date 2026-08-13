import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { storeJiraConnection } from "@/modules/auth/jira-connection.service";
import { JIRA_OAUTH_BINDING_COOKIE } from "@/modules/auth/jira-oauth-cookie";
import { getAtlassianUserIdentity } from "@/modules/auth/jira-oauth";
import { AtlassianOAuthError, AtlassianReauthorizationRequiredError } from "@/modules/auth/jira-oauth";
import { provisionJiraLogin } from "@/modules/auth/jira-provisioning.service";
import { consumeJiraSiteSelection } from "@/modules/auth/jira-site-selection.service";
import { createSession } from "@/modules/auth/session.service";

const SelectionSchema = z.object({
  continuation: z.string().trim().min(1),
  cloudId: z.string().trim().min(1),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = SelectionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A Jira continuation and site are required." }, { status: 400 });
  try {
    const cookieStore = await cookies();
    const browserBinding = cookieStore.get(JIRA_OAUTH_BINDING_COOKIE)?.value ?? "";
    const selection = await consumeJiraSiteSelection(parsed.data.continuation, browserBinding, parsed.data.cloudId);
    const identity = await getAtlassianUserIdentity(selection.accessToken, selection.resource.id);
    const provisioned = await provisionJiraLogin({ resource: selection.resource, identity });
    await storeJiraConnection({
    workspaceId: provisioned.workspaceId, userId: provisioned.userId, cloudId: selection.resource.id,
    accessToken: selection.accessToken, refreshToken: selection.refreshToken,
    expiresInSeconds: selection.expiresInSeconds, scopes: selection.scopes,
    isSyncPrincipal: provisioned.role === "owner",
    });
    await createSession({
    workspaceId: provisioned.workspaceId, userId: provisioned.userId,
    userAgent: request.headers.get("user-agent"),
    });
    cookieStore.delete(JIRA_OAUTH_BINDING_COOKIE);
    writeAuditLog({
    workspaceId: provisioned.workspaceId, actor: provisioned.userId,
    action: "USER_LOGIN", status: "Success", message: `Connected Jira Cloud site ${selection.resource.name}.`,
    });
    return NextResponse.json({ ok: true, returnTo: selection.returnTo });
  } catch (error) {
    if (error instanceof AtlassianReauthorizationRequiredError) {
      return NextResponse.json({ error: "Atlassian authorization must be renewed. Reconnect Jira." }, { status: 401 });
    }
    if (error instanceof AtlassianOAuthError) {
      return NextResponse.json({ error: "Atlassian authorization is unavailable. Try again later." }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : "";
    if (/selection|selected site|expired|already used|browser binding/i.test(message)) {
      return NextResponse.json({ error: "This Jira site selection is invalid, expired, or already used. Start again." }, { status: 400 });
    }
    return NextResponse.json({ error: "Jira site selection could not be completed. Try again." }, { status: 500 });
  }
}
