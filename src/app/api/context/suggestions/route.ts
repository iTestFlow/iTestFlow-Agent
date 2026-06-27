import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  authErrorResponse,
  getUserAzureAdapter,
  getUserLLMProvider,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { suggestContextStories } from "@/modules/context-selection/context-selection.service";
import { getContextSuggestionCandidatePoolSize, getContextSuggestionFinalLimit } from "@/modules/context-selection/context-suggestion-sizing";
import { requirementToRetrievalQuery, retrieveStoredProjectContext, type LlmContextSource } from "@/modules/rag/project-context-store.service";
import { getRetrievalTopK } from "@/modules/rag/retrieval-config";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  query: z.string().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before running this action." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const provider = await getUserLLMProvider(ctx);

    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const retrievalTopK = getContextSuggestionFinalLimit(await getRetrievalTopK(ctx.workspace.id));
    const candidatePoolSize = getContextSuggestionCandidatePoolSize(retrievalTopK);
    const storedContext = distinctContextByWorkItem(
      (await retrieveStoredProjectContext({
        scope: trustedScope,
        query: parsed.data.query?.trim() || requirementToRetrievalQuery(targetRequirement),
        topK: candidatePoolSize,
      })).filter((item) => item.workItemId !== parsed.data.targetWorkItemId),
    ).slice(0, retrievalTopK);
    if (!storedContext.length) {
      return NextResponse.json({
        targetWorkItemId: parsed.data.targetWorkItemId,
        suggestions: [],
        rawOutput: null,
        provider: provider.name,
        model: provider.model,
      });
    }
    const result = await suggestContextStories({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
      targetRequirement,
      retrievedContext: storedContext,
      maxContextItems: retrievalTopK,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      suggestions: result.validatedOutput.suggestedItems,
      rawOutput: result.rawOutput,
      provider: result.provider,
      model: result.model,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "context_selection.suggest", label: "Context suggestion failed.", error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Context suggestion failed." },
      { status: 503 },
    );
  }
}

function distinctContextByWorkItem(items: LlmContextSource[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.workItemId)) return false;
    seen.add(item.workItemId);
    return true;
  });
}
