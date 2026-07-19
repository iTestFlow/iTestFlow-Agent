import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { promoteContextChatbotAnswer } from "@/modules/rag/project-knowledge-compiled.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const CitationSchema = z.object({
  sourceType: z.enum(["project_context", "project_knowledge"]),
  sourceId: z.string().min(1),
  workItemId: z.string().optional(),
  sourceWorkItemIds: z.array(z.string()).optional(),
});

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  answer: z.string().trim().min(1),
  citations: z.array(CitationSchema).min(1),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Promoted knowledge must include a selected project, an answer, and at least one citation." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can promote answers to project knowledge.");
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json(await promoteContextChatbotAnswer({ ...parsed.data, scope: trustedScope, actor: ctx.userId }));
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "generic", status: 422, fallback: "Context chatbot answer promotion failed." });
  }
}
