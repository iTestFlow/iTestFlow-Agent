import { NextResponse } from "next/server";
import { z } from "zod";

import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please select an Azure DevOps project before loading work item metadata." },
      { status: 400 },
    );
  }

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const metadata = await adapter.fetchProjectWorkItemMetadata({
      projectId: parsed.data.scope.azureProjectId,
    });
    return NextResponse.json(metadata);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps work item metadata fetch failed." },
      { status: 503 },
    );
  }
}
