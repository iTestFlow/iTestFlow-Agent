import { NextResponse } from "next/server";
import {
  authErrorResponse,
  getUserAzureAdapterOrgLevel,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ctx = await requireWorkflowContext();
    const adapter = await getUserAzureAdapterOrgLevel(ctx);
    const projects = await adapter.fetchProjects();
    return NextResponse.json({
      mode: "live",
      organizationUrl: ctx.workspace.azureOrgUrl,
      projects: projects.map((project) => ({
        ...project,
        azureOrganizationUrl: ctx.workspace.azureOrgUrl,
      })),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Azure DevOps project fetch failed.",
      },
      { status: 503 },
    );
  }
}
