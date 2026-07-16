import { NextResponse } from "next/server";
import { z } from "zod";

import { authErrorResponse, requireWorkflowContext, requireWorkflowRole } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({ scope: ProjectScopeSchema }).passthrough();

export async function POST(request: Request, context?: unknown) {
  void context;
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can manage project knowledge.");
    await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json({
      error: "Rebase was removed in Project Knowledge v4. Start a new build to include newer sources.",
      code: "rebase_removed",
    }, { status: 410 });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { fallback: "The retired rebase endpoint could not be checked." });
  }
}
