import { NextResponse } from "next/server";
import { z } from "zod";
import { buildBugReportPromptDraft } from "@/modules/bug-reporting/bug-reporting.service";
import { BugAttachmentDescriptorSchema, BugCustomFieldValueSchema, BugRelatedTestCaseContextSchema } from "@/modules/bug-reporting/schemas/bug-report.schema";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { loadProjectKnowledgeContext } from "@/modules/rag/project-knowledge.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  bugDescription: z.string().trim().min(1, "Describe the bug before preparing the prompt."),
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

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
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

    const knowledgeContext = await loadProjectKnowledgeContext({ scope: trustedScope, consumer: "bug_reporting_manual" });
    const draft = buildBugReportPromptDraft({
      scope: trustedScope,
      bugDescription: parsed.data.bugDescription,
      parentStory,
      selectedRelatedTestCase: parsed.data.selectedRelatedTestCase,
      customFields: parsed.data.customFields,
      attachments: parsed.data.attachments,
      projectKnowledgeBase: knowledgeContext.knowledgeBase,
      projectKnowledgeNotice: knowledgeContext.promptNotice,
    });

    return NextResponse.json({
      parentStoryId: parsed.data.parentStoryId ?? null,
      ...draft,
      warnings: knowledgeContext.promptNotice ? [knowledgeContext.promptNotice] : undefined,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "llm", status: 503, fallback: "External LLM bug prompt preparation failed." });
  }
}
