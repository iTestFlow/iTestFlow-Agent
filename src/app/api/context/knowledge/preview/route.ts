import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import {
  enqueueProjectKnowledgeJob,
  isKnowledgeBuildUnavailableError,
  KNOWLEDGE_BUILD_UNAVAILABLE_CODE,
  KNOWLEDGE_BUILD_UNAVAILABLE_MESSAGE,
} from "@/modules/jobs/project-knowledge-jobs.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  mode: z.enum(["incremental", "full"]).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select a project before building knowledge." }, { status: 400 });
  }
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    const scope = await resolveProjectScope(ctx, parsed.data.scope);
    const result = await enqueueProjectKnowledgeJob({
      scope,
      workspaceId: ctx.workspace.id,
      actor: ctx.userId,
      operation: "build",
      mode: parsed.data.mode ?? "incremental",
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (isKnowledgeBuildUnavailableError(error)) {
      return NextResponse.json({ error: KNOWLEDGE_BUILD_UNAVAILABLE_MESSAGE, code: KNOWLEDGE_BUILD_UNAVAILABLE_CODE }, {
        status: 503,
        headers: { "Retry-After": "5" },
      });
    }
    return routeErrorResponse(error, { fallback: "Project knowledge build could not be queued." });
  }
}
