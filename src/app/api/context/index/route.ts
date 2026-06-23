import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import {
  completeWorkflowRun,
  failWorkflowRun,
  startWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  workItemTypes: z.array(z.string().min(1)).min(1),
  states: z.array(z.string().min(1)).min(1),
  mode: z.enum(["incremental", "rebuild"]).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please select a project, at least one work item type, and at least one state before indexing context." },
      { status: 400 },
    );
  }

  let trustedScope: ProjectScope | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "knowledge_indexing",
      userId: ctx.userId,
    });
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const result = await indexAzureWorkItemsAsProjectContext({
      scope: trustedScope,
      actor: ctx.userId,
      adapter,
      workItemTypes: parsed.data.workItemTypes,
      states: parsed.data.states,
      mode: parsed.data.mode ?? "incremental",
    });
    completeWorkflowRun({
      scope: trustedScope,
      runId: analyticsRunId,
      valueRealized: true,
      patch: {
        itemsGenerated: result.indexedWorkItemCount,
        itemsSelected: result.fetchedCount,
        itemsPublished: result.indexedWorkItemCount,
        metadata: {
          knowledge: {
            indexedWorkItemCount: result.indexedWorkItemCount,
            indexedChunkCount: result.indexedChunkCount,
          },
        },
      },
    });

    return NextResponse.json({ source: "live", analyticsRunId, ...result });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Project context indexing failed." });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project context indexing failed." },
      { status: 503 },
    );
  }
}
