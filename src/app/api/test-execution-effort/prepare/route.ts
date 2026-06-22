import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getRetrievalTopK } from "@/modules/rag/retrieval-config";
import { loadTestExecutionEffortData } from "@/modules/test-execution-effort/test-execution-effort.data-loader";
import { buildTestExecutionEffortPreview, toSafeTestExecutionEffortError } from "@/modules/test-execution-effort/test-execution-effort.service";
import {
  StoryIdSchema,
  TestExecutionEffortOptionsSchema,
} from "@/modules/test-execution-effort/test-execution-effort.schema";

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
    const adapter = await getUserAzureAdapter(ctx, parsed.data.scope);
    const data = await loadTestExecutionEffortData({
      scope: parsed.data.scope,
      adapter,
      storyId: parsed.data.storyId,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: await getRetrievalTopK(ctx.workspace.id),
    });
    const preview = buildTestExecutionEffortPreview({
      targetRequirement: data.targetRequirement,
      linkedTestCases: data.linkedTestCases,
      hasProjectContext: data.hasProjectContext,
    });

    return NextResponse.json({
      ...preview,
      selectedContextIds: parsed.data.selectedContextIds,
      resolvedContextUsed: data.resolvedContextUsed,
      retrievalTopK: data.retrievalTopK,
      options: TestExecutionEffortOptionsSchema.parse(parsed.data),
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    const safeError = toSafeTestExecutionEffortError(error, "Test Execution Effort preview failed.", parsed.data.storyId);
    return NextResponse.json({ error: safeError.message }, { status: safeError.status });
  }
}

