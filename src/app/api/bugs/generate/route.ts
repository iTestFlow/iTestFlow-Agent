import { NextResponse } from "next/server";
import { z } from "zod";
import { BugAttachmentDescriptorSchema, BugCustomFieldValueSchema, BugRelatedTestCaseContextSchema } from "@/modules/bug-reporting/schemas/bug-report.schema";
import { generateBugReport } from "@/modules/bug-reporting/bug-reporting.service";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { getConfiguredProviderFromEnv } from "@/modules/llm/configured-provider";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getSavedProjectKnowledgeBase } from "@/modules/rag/project-knowledge.service";

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

  try {
    const provider = getConfiguredProviderFromEnv();
    if (!provider) {
      return NextResponse.json(
        { error: "No LLM provider configured. Set DEFAULT_LLM_PROVIDER and the provider API key in .env.local." },
        { status: 503 },
      );
    }

    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const parentStory = parsed.data.parentStoryId
      ? await adapter.fetchWorkItemById({
          projectId: parsed.data.scope.azureProjectId,
          workItemId: parsed.data.parentStoryId,
        })
      : null;

    if (parentStory && parentStory.workItemType !== "User Story") {
      return NextResponse.json({ error: `Parent Story ID ${parentStory.id} is a ${parentStory.workItemType}, not a User Story.` }, { status: 400 });
    }

    const result = await generateBugReport({
      scope: parsed.data.scope,
      provider,
      bugDescription: parsed.data.bugDescription,
      parentStory,
      selectedRelatedTestCase: parsed.data.selectedRelatedTestCase,
      customFields: parsed.data.customFields,
      attachments: parsed.data.attachments,
      projectKnowledgeBase: getSavedProjectKnowledgeBase({ scope: parsed.data.scope }),
    });

    return NextResponse.json({
      parentStoryId: parsed.data.parentStoryId ?? null,
      provider: result.provider,
      model: result.model,
      rawOutput: result.rawOutput,
      ...result.validatedOutput,
    });
  } catch (error) {
    writeGenerationFailureAudit({ scope: parsed.data.scope, action: "bug_report.generate", label: "Bug report generation failed.", error });
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Bug report generation failed." },
      { status: 503 },
    );
  }
}
