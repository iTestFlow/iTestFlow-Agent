import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { pushApprovedRequirementComment } from "@/modules/integrations/azure-devops/azure-devops-comment.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedFindingIds: z.array(z.string()).min(1),
  commentBody: z.string().min(1),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "A selected project, target story, selected findings, and comment body are required." }, { status: 400 });
  }

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const result = await pushApprovedRequirementComment(adapter, parsed.data.scope, {
      workItemId: parsed.data.targetWorkItemId,
      commentBody: parsed.data.commentBody,
    });

    return NextResponse.json(result, { status: result.success ? 200 : 502 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps comment push failed." },
      { status: 503 },
    );
  }
}
