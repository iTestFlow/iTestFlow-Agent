import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  workItemId: z.string().trim().regex(/^\d+$/, "Enter a valid numeric work item ID."),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Selected project and work item ID are required." }, { status: 400 });
  }

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const workItem = await adapter.fetchWorkItemById({
      projectId: parsed.data.scope.azureProjectId,
      workItemId: parsed.data.workItemId,
    });
    return NextResponse.json({ workItem });
  } catch (error) {
    return NextResponse.json(
      { error: friendlyWorkItemError(error, parsed.data.workItemId) },
      { status: 503 },
    );
  }
}

function friendlyWorkItemError(error: unknown, workItemId: string) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("404") || message.includes("TF401232") || message.includes("WorkItemUnauthorizedAccessException")) {
    return `Work item ${workItemId} was not found, or your Azure DevOps account does not have permission to read it. Check the ID and selected project.`;
  }
  if (message.includes("401") || message.includes("403")) {
    return "Azure DevOps rejected the request. Check that your connection settings and permissions allow reading work items.";
  }
  return "Could not load this work item from Azure DevOps. Check the ID, selected project, and connection settings.";
}
