import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { ProjectKnowledgeBaseSchema } from "@/modules/rag/project-knowledge.schema";
import { saveGeneratedProjectKnowledgeBaseDraft } from "@/modules/rag/project-knowledge.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  rawOutput: z.string().min(1),
  requestedMode: z.enum(["incremental", "full"]).optional(),
  mode: z.enum(["incremental", "full"]),
  knowledgeBase: ProjectKnowledgeBaseSchema,
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Preview generated knowledge before saving." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    return NextResponse.json(await saveGeneratedProjectKnowledgeBaseDraft({ ...parsed.data, scope: trustedScope, actor: ctx.userId }));
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project knowledge save failed." },
      { status: 422 },
    );
  }
}
