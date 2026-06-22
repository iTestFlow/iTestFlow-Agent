import { NextResponse } from "next/server";
import { z } from "zod";
import { BugAttachmentDescriptorSchema, BugCustomFieldValueSchema, BugRelatedTestCaseContextSchema } from "@/modules/bug-reporting/schemas/bug-report.schema";
import { generateBugReport } from "@/modules/bug-reporting/bug-reporting.service";
import {
  authErrorResponse,
  getUserAzureAdapter,
  getUserLLMProvider,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";
import { statusForServerError, toErrorResponse } from "@/modules/shared/errors/error-response";
import {
  failWorkflowRun,
  startWorkflowRun,
  updateWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  bugDescription: z.string().trim().min(1, "Describe the bug before generating a report."),
  parentStoryId: z.string().trim().optional(),
  selectedRelatedTestCase: BugRelatedTestCaseContextSchema.optional(),
  customFields: z.array(BugCustomFieldValueSchema).optional().default([]),
  attachments: z.array(BugAttachmentDescriptorSchema).optional().default([]),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Bug description is required." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let analyticsRunId: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const provider = await getUserLLMProvider(ctx);
    analyticsRunId = startWorkflowRun({
      scope: trustedScope,
      workflowType: "report_bug",
      workItemId: parsed.data.parentStoryId,
      userId: ctx.userId,
    });

    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const parentStory = parsed.data.parentStoryId
      ? await adapter.fetchWorkItemById({
          projectId: trustedScope.azureProjectId,
          workItemId: parsed.data.parentStoryId,
        })
      : null;

    if (parentStory && parentStory.workItemType !== "User Story") {
      return NextResponse.json({ error: `Parent Story ID ${parentStory.id} is a ${parentStory.workItemType}, not a User Story.` }, { status: 400 });
    }

    const result = await generateBugReport({
      scope: trustedScope,
      provider,
      bugDescription: parsed.data.bugDescription,
      parentStory,
      selectedRelatedTestCase: parsed.data.selectedRelatedTestCase,
      customFields: parsed.data.customFields,
      attachments: parsed.data.attachments,
      projectKnowledgeBase: await getSavedProjectKnowledgeBase({ scope: trustedScope }),
    });
    updateWorkflowRun({
      scope: trustedScope,
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
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope) writeGenerationFailureAudit({ scope: trustedScope, action: "bug_report.generate", label: "Bug report generation failed.", error });
    if (trustedScope && analyticsRunId) {
      failWorkflowRun({ scope: trustedScope, runId: analyticsRunId, error: error instanceof Error ? error.message : "Bug report generation failed." });
    }
    return NextResponse.json(toErrorResponse(error), { status: statusForServerError(error) });
  }
}
