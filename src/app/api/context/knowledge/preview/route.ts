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
import { previewGeneratedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  mode: z.enum(["incremental", "full"]).optional(),
});

const InvalidKnowledgeBaseOutputMessage =
  "The model returned invalid knowledge-base JSON. No data was saved. Please retry extraction or reduce indexed context size.";
const TruncatedKnowledgeBaseOutputMessage =
  "The model ran out of output tokens before completing the knowledge-base JSON. No data was saved. Please retry extraction; if it still fails, increase max tokens or index a narrower context.";

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before previewing the knowledge base." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireWorkflowRole(ctx, ["owner", "admin"], "Only workspace owners and admins can build project knowledge.");
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const provider = await getUserLLMProvider(ctx);

    const draft = await previewGeneratedProjectKnowledgeBase({
      scope: trustedScope,
      provider,
      mode: parsed.data.mode ?? "incremental",
    });
    return NextResponse.json({
      ...draft,
      tokenUsage: provider.getTokenUsage() ?? (draft.provider === "local" ? { input: 0, output: 0, total: 0 } : undefined),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "rag.preview_project_knowledge_base", label: "Project knowledge preview failed.", error });
    if (isTruncatedKnowledgeBaseOutputError(error)) {
      return NextResponse.json({ error: TruncatedKnowledgeBaseOutputMessage }, { status: 422 });
    }

    if (isInvalidKnowledgeBaseOutputError(error)) {
      return NextResponse.json({ error: InvalidKnowledgeBaseOutputMessage }, { status: 422 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Project knowledge preview failed." },
      { status: 503 },
    );
  }
}

function isTruncatedKnowledgeBaseOutputError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /max output token|token budget|finishReason.*MAX_TOKENS/i.test(error.message);
}

function isInvalidKnowledgeBaseOutputError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return /json|parse|validation|schema/i.test(error.message);
}
