import { NextResponse } from "next/server";
import { z } from "zod";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getEffectiveRuntimeSettings } from "@/modules/settings/runtime-settings.service";
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
    const adapter = getConfiguredAzureDevOpsAdapter();
    const data = await loadTestExecutionEffortData({
      scope: parsed.data.scope,
      adapter,
      storyId: parsed.data.storyId,
      selectedContextIds: parsed.data.selectedContextIds,
      retrievalTopK: getEffectiveRuntimeSettings()?.context.retrievalTopK ?? 8,
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
    const safeError = toSafeTestExecutionEffortError(error, "Test Execution Effort preview failed.", parsed.data.storyId);
    return NextResponse.json({ error: safeError.message }, { status: safeError.status });
  }
}

