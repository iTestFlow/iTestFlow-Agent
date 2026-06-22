import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { pushApprovedRequirementComment } from "@/modules/integrations/azure-devops/azure-devops-comment.service";
import {
  completeWorkflowRun,
  failWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

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

  let trustedScope: ProjectScope | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const result = await pushApprovedRequirementComment(adapter, trustedScope, {
      workItemId: parsed.data.targetWorkItemId,
      commentBody: parsed.data.commentBody,
      mentionedUsers: parsed.data.mentionedUsers,
    });
    if (parsed.data.analyticsRunId) {
      if (result.success) {
        completeWorkflowRun({
          scope: trustedScope,
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
        failWorkflowRun({ scope: trustedScope, runId: parsed.data.analyticsRunId, error: "Requirement comment publish failed." });
      }
    }

    return NextResponse.json(result, { status: result.success ? 200 : 502 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && parsed.data.analyticsRunId) {
      failWorkflowRun({
        scope: trustedScope,
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
