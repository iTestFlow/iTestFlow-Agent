import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { authErrorResponse, getUserAzureAdapter, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { normalizeTestCasePriority } from "@/modules/integrations/azure-devops/publish-normalization";
import {
  completeWorkflowRun,
  failWorkflowRun,
} from "@/modules/analytics/workflow-analytics.service";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const TestCasePrioritySchema = z.preprocess(
  normalizeTestCasePriority,
  z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
);

const SuggestedAdditionSchema = z.object({
  localId: z.string().min(1),
  targetUserStoryId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  preconditions: z.string().optional(),
  steps: z.array(z.object({ action: z.string().min(1), expectedResult: z.string().min(1) })).min(1),
  testData: z.string().optional(),
  expectedResult: z.string().optional(),
  priority: TestCasePrioritySchema,
  testType: z.string().optional(),
  automationSuitability: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  testCases: z.array(SuggestedAdditionSchema).min(1),
  analyticsRunId: z.string().min(1).optional(),
  itemsGenerated: z.number().int().nonnegative().optional(),
  itemsEdited: z.number().int().nonnegative().optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Selected project, user story, and suggested test cases are required." },
      { status: 400 },
    );
  }

  let trustedScope: ProjectScope | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const results = [];

    for (const testCase of parsed.data.testCases) {
      const created = await adapter.createTestCase({
        projectId: trustedScope.azureProjectId,
        testCase,
      });

      if (!created.success || !created.azureTestCaseId) {
        results.push({
          localId: testCase.localId,
          azureTestCaseId: created.azureTestCaseId,
          success: false,
          create: created,
          link: { success: false, error: "Skipped because test case creation failed." },
          error: created.error,
        });
        continue;
      }

      const link = await adapter.linkTestCaseToUserStory({
        projectId: trustedScope.azureProjectId,
        userStoryId: parsed.data.targetWorkItemId,
        azureTestCaseId: created.azureTestCaseId,
      });

      results.push({
        localId: testCase.localId,
        azureTestCaseId: created.azureTestCaseId,
        success: created.success && link.success,
        create: created,
        link,
        error: link.error,
      });
    }

    writeAuditLog({
      projectId: trustedScope.projectId,
      azureProjectId: trustedScope.azureProjectId,
      azureProjectName: trustedScope.azureProjectName,
      azureOrganizationUrl: trustedScope.azureOrganizationUrl,
      actor: ctx.userId,
      entityType: "work_item",
      entityId: parsed.data.targetWorkItemId,
      action: "test_coverage_matrix.publish_suggested_additions",
      status: results.every((result) => result.success) ? "Success" : results.some((result) => result.success) ? "Partial failure" : "Failed",
      message: `Created and linked ${results.filter((result) => result.success).length} of ${parsed.data.testCases.length} suggested test cases.`,
      details: { results },
    });
    const successCount = results.filter((result) => result.success).length;
    if (parsed.data.analyticsRunId) {
      if (successCount > 0) {
        completeWorkflowRun({
          scope: trustedScope,
          runId: parsed.data.analyticsRunId,
          status: "published",
          valueRealized: true,
          patch: {
            itemsSelected: parsed.data.testCases.length,
            itemsEdited: parsed.data.itemsEdited ?? 0,
            itemsPublished: successCount,
            itemsRejected: Math.max((parsed.data.itemsGenerated ?? parsed.data.testCases.length) - parsed.data.testCases.length, 0),
            manualActionsAvoided: results.reduce(
              (total, result) => total + (result.create.success ? 1 : 0) + (result.link.success ? 1 : 0),
              0,
            ),
          },
        });
      } else {
        failWorkflowRun({ scope: trustedScope, runId: parsed.data.analyticsRunId, error: "No suggested test cases were published successfully." });
      }
    }

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      results,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && parsed.data.analyticsRunId) {
      failWorkflowRun({
        scope: trustedScope,
        runId: parsed.data.analyticsRunId,
        error: error instanceof Error ? error.message : "Suggested additions publish failed.",
      });
    }
    return routeErrorResponse(error, { domain: "azure", status: 503, fallback: "Suggested additions publish failed." });
  }
}
