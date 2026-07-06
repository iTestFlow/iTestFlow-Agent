import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserLLMProvider,
  requireWorkflowContext,
  requireWorkflowRole,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  InvalidKnowledgeBaseOutputMessage,
  TruncatedKnowledgeBaseOutputMessage,
  isInvalidKnowledgeBaseOutputError,
  isTruncatedKnowledgeBaseOutputError,
} from "@/modules/rag/knowledge-error-classification";
import { extractAndSaveProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  mode: z.enum(["incremental", "full"]).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before extracting the knowledge base." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const provider = await getUserLLMProvider(ctx);

    const snapshot = await extractAndSaveProjectKnowledgeBase({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
      mode: parsed.data.mode ?? "incremental",
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "rag.extract_project_knowledge_base", label: "Project knowledge extraction failed.", error });
    // Unlike the preview route, there is no isAppError branch here: AppErrors are
    // classified by message regex like any other Error (or fall through to 503).
    if (isTruncatedKnowledgeBaseOutputError(error)) {
      return NextResponse.json({ error: TruncatedKnowledgeBaseOutputMessage }, { status: 422 });
    }

    if (isInvalidKnowledgeBaseOutputError(error)) {
      return NextResponse.json({ error: InvalidKnowledgeBaseOutputMessage }, { status: 422 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project knowledge extraction failed." },
      { status: 503 },
    );
  }
}
