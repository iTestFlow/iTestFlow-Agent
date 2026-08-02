import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authErrorResponse,
  getUserAzureAdapter,
  requireExternalLlmEnabled,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveRetrievalTopK } from "@/modules/rag/retrieval-config";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { loadTestExecutionEffortData } from "@/modules/test-execution-effort/test-execution-effort.data-loader";
import {
  buildTestExecutionEffortPreview,
  buildTestExecutionEffortPromptDraft,
  toSafeTestExecutionEffortError,
} from "@/modules/test-execution-effort/test-execution-effort.service";
import {
  StoryIdSchema,
  TestExecutionEffortOptionsSchema,
} from "@/modules/test-execution-effort/test-execution-effort.schema";
import { buildWorkflowContextCitations } from "@/modules/rag/workflow-context-citations";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { statusForServerError } from "@/modules/shared/errors/error-response";
import { integrationScopeHeaders } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  storyId: StoryIdSchema,
  selectedContextIds: z.array(z.string()).optional().default([]),
}).merge(TestExecutionEffortOptionsSchema);

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Please select an Azure DevOps project and enter a valid User Story ID." },
      { status: 400 },
    );
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    await requireExternalLlmEnabled(ctx);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const options = TestExecutionEffortOptionsSchema.parse(parsed.data);
    const data = await loadTestExecutionEffortData({
      scope: trustedScope,
      adapter,
      storyId: parsed.data.storyId,
      selectedContextIds: parsed.data.selectedContextIds,
      // The requirement is fetched inside the data loader, not available here; the
      // query param is a documented no-op until the adaptive-K heuristic lands
      // (retrieval-config.ts), at which point topK resolution should move into
      // loadTestExecutionEffortData where the requirement text is in hand.
      retrievalTopK: await resolveRetrievalTopK({ workspaceId: ctx.workspace.id, query: "" }),
    });
    const preview = buildTestExecutionEffortPreview({
      targetRequirement: data.targetRequirement,
      linkedTestCases: data.linkedTestCases,
      hasProjectContext: data.hasProjectContext,
    });
    // The prompt a user copies out has to be the prompt the internal run would build.
    // Without these three it silently fell back to keyword-only knowledge ranking and a
    // hardcoded related-items floor, so "prepare the prompt" and "run it here" produced
    // materially different context for the same work item, with nothing saying so.
    // There is no LLM provider on this path, so the model window comes from the
    // workspace's configured override — the admin's own statement of what their models
    // accept — rather than a fixed fallback.
    const workspaceSettings = await getWorkspaceSettings(ctx.workspace.id);
    const draft = buildTestExecutionEffortPromptDraft({
      scope: trustedScope,
      targetRequirement: data.targetRequirement,
      linkedTestCases: data.linkedTestCases,
      relatedWorkItems: data.relatedWorkItems,
      selectedContext: data.selectedContext,
      projectKnowledgeBase: data.projectKnowledgeBase,
      projectKnowledgeNotice: data.projectKnowledgeNotice,
      maxInputTokens: workspaceSettings?.modelInputTokenLimitOverride ?? undefined,
      relatedWorkItemsFloor: data.retrievalTopK,
      rankedKnowledgeKeys: data.rankedKnowledgeKeys ?? undefined,
      options,
    });
    const contextCitations = buildWorkflowContextCitations({
      resolvedContextUsed: data.resolvedContextUsed,
      relevantProjectKnowledgeBase: draft.relevantProjectKnowledgeBase,
    });

    return NextResponse.json({
      ...preview,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: data.resolvedContextUsed,
      contextCitations,
      retrievalTopK: data.retrievalTopK,
      options,
      ...draft,
      warnings: data.projectKnowledgeNotice ? [data.projectKnowledgeNotice] : undefined,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const safeError = toSafeTestExecutionEffortError(error, "External LLM Test Execution Effort prompt preparation failed.", parsed.data.storyId);
    const status = statusForServerError(error, { status: safeError.status });
    const headers = integrationScopeHeaders(error);
    return NextResponse.json({ error: safeError.message }, headers ? { status, headers } : { status });
  }
}

