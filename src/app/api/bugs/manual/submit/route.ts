import { NextResponse } from "next/server";
import { z } from "zod";
import { completeManualBugReport } from "@/modules/bug-reporting/bug-reporting.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { isAppError } from "@/modules/shared/errors/app-error";
import { statusForManualValidationError, toErrorResponse } from "@/modules/shared/errors/error-response";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  rawOutput: z.string().min(1),
  parentStoryId: z.string().trim().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste the external LLM response before continuing." }, { status: 400 });
  }

  const analyticsRunId = startWorkflowRun({
    scope: parsed.data.scope,
    workflowType: "report_bug",
    workItemId: parsed.data.parentStoryId,
  });
  try {
    const result = completeManualBugReport({
      scope: parsed.data.scope,
      rawOutput: parsed.data.rawOutput,
      parentStoryId: parsed.data.parentStoryId,
    });
    updateWorkflowRun({
      scope: parsed.data.scope,
      runId: analyticsRunId,
      patch: {
        status: "generated",
        generationCompletedAt: new Date().toISOString(),
        itemsGenerated: 1,
        usedKnowledgeContext: result.validatedOutput.contextUsed.length > 0,
        metadata: { contextUsed: result.validatedOutput.contextUsed },
      },
    });

    return NextResponse.json({
      analyticsRunId,
      parentStoryId: parsed.data.parentStoryId ?? null,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
    });
  } catch (error) {
    failWorkflowRun({ scope: parsed.data.scope, runId: analyticsRunId, error: error instanceof Error ? error.message : "External bug response validation failed." });
    if (isAppError(error)) {
      return NextResponse.json(toErrorResponse(error), { status: statusForManualValidationError(error) });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "External LLM bug response validation failed." },
      { status: 422 },
    );
  }
}
