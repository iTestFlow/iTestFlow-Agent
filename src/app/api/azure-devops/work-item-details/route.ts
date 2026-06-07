import { NextResponse } from "next/server";
import { z } from "zod";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema, ProjectIsolationError, workItemNotInProjectMessage } from "@/modules/projects/project-isolation.guard";

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
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const workItem = await adapter.fetchWorkItemById({
      projectId: parsed.data.scope.azureProjectId,
      workItemId: parsed.data.workItemId,
    });
    return NextResponse.json({ workItem });
  } catch (error) {
    // A work item that belongs to another project, does not exist, or the account
    // cannot read are intentionally indistinguishable: one message, 404.
    if (error instanceof ProjectIsolationError || isWorkItemNotFound(error)) {
      return NextResponse.json({ error: workItemNotInProjectMessage(parsed.data.workItemId) }, { status: 404 });
    }
    return NextResponse.json(
      { error: friendlyWorkItemError(error) },
      { status: 503 },
    );
  }
}

function isWorkItemNotFound(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("404") ||
    message.includes("TF401232") ||
    message.includes("WorkItemUnauthorizedAccessException")
  );
}

function friendlyWorkItemError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("401") || message.includes("403")) {
    return "Azure DevOps rejected the request. Check that your connection settings and permissions allow reading work items.";
  }
  return "Could not load this work item from Azure DevOps. Check the ID, selected project, and connection settings.";
}
