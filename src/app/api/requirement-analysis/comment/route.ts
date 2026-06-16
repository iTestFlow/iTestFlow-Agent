import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { pushApprovedRequirementComment } from "@/modules/integrations/azure-devops/azure-devops-comment.service";
import {
  completeWorkflowRun,
  failWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";

export const runtime = "nodejs";

const MentionedUserSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  uniqueName: z.string().optional(),
});

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  selectedFindingIds: z.array(z.string()).min(1),
  commentBody: z.string().min(1),
  mentionedUsers: z.array(MentionedUserSchema).default([]),
  analyticsRunId: z.string().min(1).optional(),
  itemsGenerated: z.number().int().nonnegative().optional(),
  itemsEdited: z.number().int().nonnegative().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "A selected project, target story, selected findings, and comment body are required." }, { status: 400 });
  }

  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const result = await pushApprovedRequirementComment(adapter, parsed.data.scope, {
      workItemId: parsed.data.targetWorkItemId,
      commentBody: parsed.data.commentBody,
      mentionedUsers: parsed.data.mentionedUsers,
    });
    if (parsed.data.analyticsRunId) {
      if (result.success) {
        completeWorkflowRun({
          scope: parsed.data.scope,
          runId: parsed.data.analyticsRunId,
          status: "published",
          valueRealized: true,
          patch: {
            itemsSelected: parsed.data.selectedFindingIds.length,
            itemsEdited: parsed.data.itemsEdited ?? 0,
            itemsPublished: parsed.data.selectedFindingIds.length,
            itemsRejected: Math.max((parsed.data.itemsGenerated ?? parsed.data.selectedFindingIds.length) - parsed.data.selectedFindingIds.length, 0),
            manualActionsAvoided: 1,
          },
        });
      } else {
        failWorkflowRun({ scope: parsed.data.scope, runId: parsed.data.analyticsRunId, error: "Requirement comment publish failed." });
      }
    }

    return NextResponse.json(result, { status: result.success ? 200 : 502 });
  } catch (error) {
    if (parsed.data.analyticsRunId) {
      failWorkflowRun({
        scope: parsed.data.scope,
        runId: parsed.data.analyticsRunId,
        error: error instanceof Error ? error.message : "Azure DevOps comment push failed.",
      });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure DevOps comment push failed." },
      { status: 503 },
    );
  }
}
