import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserLLMProvider,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { extractAndSaveProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";

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
    return NextResponse.json({ error: "Please select an Azure DevOps project before extracting the knowledge base." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const provider = await getUserLLMProvider(ctx);

    const snapshot = await extractAndSaveProjectKnowledgeBase({
      scope: parsed.data.scope,
      provider,
      mode: parsed.data.mode ?? "incremental",
    });

    return NextResponse.json(snapshot);
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    writeGenerationFailureAudit({ scope: parsed.data.scope, action: "rag.extract_project_knowledge_base", label: "Project knowledge extraction failed.", error });
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

function isTruncatedKnowledgeBaseOutputError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /max output token|token budget|finishReason.*MAX_TOKENS/i.test(error.message);
}

function isInvalidKnowledgeBaseOutputError(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError) return true;
  if (!(error instanceof Error)) return false;
  return /json|parse|validation|schema/i.test(error.message);
}
