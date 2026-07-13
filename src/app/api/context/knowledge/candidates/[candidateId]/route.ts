import { NextResponse } from "next/server";
import { z } from "zod";

import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import {
  getProjectKnowledgeCandidate,
  rejectProjectKnowledgeCandidate,
  requestProjectKnowledgeCandidateIntegration,
} from "@/modules/rag/project-knowledge-compiled.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const ReadSchema = z.object({ scope: ProjectScopeSchema });
const MutationSchema = ReadSchema.extend({
  action: z.enum(["reject", "request_integration"]),
  reason: z.string().trim().min(1).max(1000).optional(),
}).refine((input) => input.action !== "reject" || Boolean(input.reason), {
  message: "A rejection reason is required.",
});
type RouteParams = { params: Promise<{ candidateId: string }> };

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = ReadSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { candidateId } = await params;
    const candidate = await getProjectKnowledgeCandidate({ scope, candidateId });
    return candidate
      ? NextResponse.json({ candidate })
      : NextResponse.json({ error: "The candidate was not found." }, { status: 404 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Project knowledge candidate could not be loaded." });
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const parsed = MutationSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid candidate action." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can change knowledge candidates.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const { candidateId } = await params;
    const candidate = parsed.data.action === "reject"
      ? await rejectProjectKnowledgeCandidate({
          scope,
          candidateId,
          actor: ctx.userId,
          reason: parsed.data.reason!,
        })
      : await requestProjectKnowledgeCandidateIntegration({ scope, candidateId, actor: ctx.userId });
    return NextResponse.json({ candidate });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "Project knowledge candidate update failed." });
  }
}
