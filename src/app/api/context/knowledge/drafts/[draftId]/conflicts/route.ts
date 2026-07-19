import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { getProjectKnowledgeDraftConflicts } from "@/modules/rag/project-knowledge-draft.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";
type RouteParams = { params: Promise<{ draftId: string }> };

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(50).optional(),
});

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { draftId } = await params;
    return NextResponse.json(await getProjectKnowledgeDraftConflicts({
      scope,
      draftId,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
    }));
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Knowledge conflicts could not be loaded." });
  }
}
