import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import {
  ProjectKnowledgeConflictDecisionSchema,
} from "@/modules/jobs/project-knowledge-jobs.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { applyKnowledgeConflictDecisions } from "@/modules/rag/project-knowledge-actions.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ draftId: string }> };

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  draftVersion: z.string().min(1),
  decisions: z.array(ProjectKnowledgeConflictDecisionSchema).min(1),
});

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "A draft version and compact decisions are required." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can resolve knowledge conflicts.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { draftId } = await params;
    const result = await applyKnowledgeConflictDecisions({
      scope,
      actor: ctx.userId,
      draftId,
      draftVersion: parsed.data.draftVersion,
      decisions: parsed.data.decisions,
    });
    return NextResponse.json(result);
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Conflict decisions could not be applied." });
  }
}
