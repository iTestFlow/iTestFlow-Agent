import { NextResponse } from "next/server";
import {
  getConfiguredAzureDevOpsAdapter,
  getConfiguredAzureDevOpsOrganizationUrl,
} from "@/modules/integrations/azure-devops/configured-azure-devops";

export const runtime = "nodejs";

export async function GET() {
  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const projects = await adapter.fetchProjects();
    return NextResponse.json({
      mode: "live",
      organizationUrl: getConfiguredAzureDevOpsOrganizationUrl(),
      projects: projects.map((project) => ({
        ...project,
        azureOrganizationUrl: getConfiguredAzureDevOpsOrganizationUrl(),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Azure DevOps project fetch failed.",
      },
      { status: 503 },
    );
  }
}
