import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import {
  getProjectKnowledgeCompilerGovernance,
  startProjectKnowledgeMilestone3Ga,
} from "@/modules/rag/project-knowledge-draft.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

const RequestSchema = z.object({ scope: ProjectScopeSchema });
const PatchRequestSchema = z.object({
  scope: ProjectScopeSchema,
  action: z.literal("start_milestone3_ga"),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json(await getProjectKnowledgeCompilerGovernance({ scope }));
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Knowledge compiler governance could not be loaded." });
  }
}

export async function PATCH(request: Request) {
  const parsed = PatchRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid governance action is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can start the GA measurement clock.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json(await startProjectKnowledgeMilestone3Ga({ scope, actor: ctx.userId }));
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The Milestone 3 GA clock could not be started." });
  }
}
