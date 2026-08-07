import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";
import {
  CandidateAlreadyPublishedError,
  updateDefectCandidate,
} from "@/modules/test-execution/defect-candidate.service";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ candidateId: string }> };

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  status: z.enum(["proposed", "selected", "dismissed"]).optional(),
  draft: z.record(z.unknown()).optional(),
});

export async function PATCH(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "The candidate update is not valid." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { candidateId } = await params;
    const updated = await updateDefectCandidate({
      workspaceId: ctx.workspace.id,
      scope,
      actor: ctx.userId,
      candidateId,
      status: parsed.data.status,
      draft: parsed.data.draft,
    });
    return updated
      ? NextResponse.json({ updated: true })
      : NextResponse.json({ error: "The defect candidate was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof CandidateAlreadyPublishedError) {
      return NextResponse.json(
        { error: "A published candidate can no longer be edited." },
        { status: 409 },
      );
    }
    return routeErrorResponse(error, { fallback: "The defect candidate could not be updated." });
  }
}
