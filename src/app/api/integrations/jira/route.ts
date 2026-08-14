import { NextResponse } from "next/server";
import { z } from "zod";

import { resolveJiraAccessToken, revokeJiraConnection } from "@/modules/auth/jira-connection.service";
import { getUserWorkManagementProviderOrgLevel } from "@/modules/credentials/scoped-resolution.service";
import { resolveJiraFieldConflict } from "@/modules/integrations/jira-cloud/jira-conflict-resolution.service";
import { storePlainJiraArtifactConfig } from "@/modules/integrations/jira-cloud/jira-artifact-publishing.service";
import { storeXrayCloudConfig } from "@/modules/integrations/jira-cloud/xray-cloud-config.service";
import { storeZephyrScaleConfig } from "@/modules/integrations/jira-cloud/zephyr-scale-config.service";
import { registerJiraProjectWebhook } from "@/modules/integrations/jira-cloud/jira-webhook-registration.service";
import { getJiraIntegrationOverview, storeJiraProjectSyncConfig } from "@/modules/projects/jira-project-mapping.service";
import { verifyAndUpsertWorkspaceProject } from "@/modules/projects/workspace-projects.service";
import { resolveWorkspaceRequest, workspaceRequestError, type WorkspaceRequestContext } from "@/modules/workspace/workspace-request";

export const runtime = "nodejs";

const Pair = z.object({ localField: z.string().trim().min(1).max(100), jiraField: z.string().trim().min(1).max(100) }).strict();
const StatusPair = z.object({ localStatus: z.string().trim().min(1).max(100), jiraStatus: z.string().trim().min(1).max(100) }).strict();
const ActionSchema = z.union([
  z.object({ action: z.literal("select_project"), providerProjectId: z.string().trim().min(1) }).strict(),
  z.object({
    action: z.literal("configure_sync"), projectId: z.string().trim().min(1),
    direction: z.enum(["jira_to_itestflow", "itestflow_to_jira", "two_way"]),
    fieldMappings: z.array(Pair).min(1).max(50), statusMappings: z.array(StatusPair).min(1).max(50),
  }).strict(),
  z.object({
    action: z.literal("configure_backend"), projectId: z.string().trim().min(1), backendType: z.literal("plain_jira"),
    testCaseIssueTypeId: z.string().regex(/^[1-9][0-9]*$/), localIdFieldId: z.string().regex(/^customfield_[0-9]+$/),
  }).strict(),
  z.object({
    action: z.literal("configure_backend"), projectId: z.string().trim().min(1), backendType: z.literal("xray_cloud"),
    clientId: z.string().trim().min(1), clientSecret: z.string().min(1), localIdFieldId: z.string().regex(/^customfield_[0-9]+$/),
  }).strict(),
  z.object({
    action: z.literal("configure_backend"), projectId: z.string().trim().min(1), backendType: z.literal("zephyr_scale"),
    apiToken: z.string().min(1), region: z.enum(["us", "eu", "au", "de"]), localIdFieldName: z.string().trim().min(1).max(255),
  }).strict(),
  z.object({
    action: z.literal("resolve_conflict"), mappingId: z.string().trim().min(1), field: z.string().trim().min(1).max(100),
    resolution: z.enum(["use_local", "use_remote"]),
  }).strict(),
]);

export async function GET() {
  try {
    const context = await requireJiraContext();
    const overview = await getJiraIntegrationOverview({ workspaceId: context.workspace.id, actorUserId: context.userId });
    let availableProjects: Awaited<ReturnType<Awaited<ReturnType<typeof getUserWorkManagementProviderOrgLevel>>["fetchProjects"]>> = [];
    if (overview.connection.status === "active") {
      const provider = await getUserWorkManagementProviderOrgLevel(context);
      availableProjects = await provider.fetchProjects();
    }
    return NextResponse.json({ ...overview, availableProjects }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return jiraSettingsError(error);
  }
}

export async function POST(request: Request) {
  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Jira integration settings are invalid." }, { status: 400 });
  try {
    const context = await requireJiraContext();
    const base = { workspaceId: context.workspace.id, actorUserId: context.userId };
    const action = parsed.data;
    if (action.action === "select_project") {
      const project = await verifyAndUpsertWorkspaceProject(context, action.providerProjectId);
      const cloudId = context.workspace.providerSiteId;
      const publicUrl = process.env.ITESTFLOW_PUBLIC_URL?.trim();
      if (!cloudId || !publicUrl) throw new Error("Jira webhook configuration is not available.");
      let publicOrigin: URL;
      try { publicOrigin = new URL(publicUrl); } catch { throw new Error("Jira webhook configuration is not available."); }
      if (publicOrigin.protocol !== "https:" || publicOrigin.username || publicOrigin.password || publicOrigin.pathname !== "/" || publicOrigin.search || publicOrigin.hash) {
        throw new Error("Jira webhook configuration is not available.");
      }
      const callbackUrl = new URL("/api/webhooks/jira", publicOrigin).toString();
      const accessToken = await resolveJiraAccessToken({ workspaceId: context.workspace.id, userId: context.userId });
      await registerJiraProjectWebhook({ workspaceId: context.workspace.id, projectId: project.projectId, cloudId, accessToken, callbackUrl });
      return NextResponse.json({ ok: true, project });
    }
    if (action.action === "configure_sync") {
      await storeJiraProjectSyncConfig({ ...base, projectId: action.projectId, direction: action.direction, fieldMappings: action.fieldMappings, statusMappings: action.statusMappings });
      return NextResponse.json({ ok: true });
    }
    if (action.action === "resolve_conflict") {
      const result = await resolveJiraFieldConflict({ workspaceId: context.workspace.id, mappingId: action.mappingId, field: action.field, resolution: action.resolution, userId: context.userId });
      return NextResponse.json({ ok: true, result });
    }
    if (action.backendType === "plain_jira") await storePlainJiraArtifactConfig({ ...base, projectId: action.projectId, testCaseIssueTypeId: action.testCaseIssueTypeId, localIdFieldId: action.localIdFieldId });
    if (action.backendType === "xray_cloud") await storeXrayCloudConfig({ ...base, projectId: action.projectId, clientId: action.clientId, clientSecret: action.clientSecret, localIdFieldId: action.localIdFieldId });
    if (action.backendType === "zephyr_scale") await storeZephyrScaleConfig({ ...base, projectId: action.projectId, apiToken: action.apiToken, region: action.region, localIdFieldName: action.localIdFieldName });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jiraSettingsError(error);
  }
}

export async function DELETE() {
  try {
    const context = await requireJiraContext();
    await revokeJiraConnection({ workspaceId: context.workspace.id, actorUserId: context.userId, targetUserId: context.userId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return jiraSettingsError(error);
  }
}

async function requireJiraContext(): Promise<WorkspaceRequestContext> {
  const context = await resolveWorkspaceRequest();
  if (context.workspace.providerId !== "jira-cloud") throw new Error("This workspace uses a different integration provider.");
  return context;
}

function jiraSettingsError(error: unknown): NextResponse {
  const access = workspaceRequestError(error);
  if (access) return access;
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : "";
  if (message.includes("artifact publish is active")) {
    return NextResponse.json({ error: "A Jira artifact publish is active. Retry after it completes." }, { status: 409 });
  }
  if (message.includes("invalid") || message.includes("duplicate")) return NextResponse.json({ error: "Jira integration settings are invalid." }, { status: 400 });
  if (message.includes("not authorized") || message.includes("not permitted")) return NextResponse.json({ error: "You are not permitted to change this Jira configuration." }, { status: 403 });
  if (message.includes("different integration provider") || message.includes("not available")) return NextResponse.json({ error: "Jira Cloud is not available for this workspace." }, { status: 404 });
  return NextResponse.json({ error: "Jira integration settings are temporarily unavailable." }, { status: 503 });
}
