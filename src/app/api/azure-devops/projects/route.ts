import { NextResponse } from "next/server";
import {
  authErrorResponse,
  getUserAzureAdapterOrgLevel,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ctx = await requireWorkflowContext();
    const adapter = await getUserAzureAdapterOrgLevel(ctx);
    const projects = await adapter.fetchProjects();
    const isJira = ctx.workspace.providerId === "jira-cloud";
    const organizationUrl = isJira ? ctx.workspace.providerSiteUrl ?? "" : ctx.workspace.azureOrgUrl;
    return NextResponse.json({
      mode: "live",
      ...(isJira ? { providerId: "jira-cloud", providerSiteName: ctx.workspace.providerSiteName } : {}),
      organizationUrl,
      workspaceId: ctx.workspace.id,
      projects: projects.map((project) => ({
        ...project,
        ...(isJira ? { providerProjectId: project.id, providerProjectKey: project.key } : {}),
        azureOrganizationUrl: organizationUrl,
        workspaceId: ctx.workspace.id,
      })),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "azure", status: 503, fallback: "Azure DevOps project fetch failed." });
  }
}
