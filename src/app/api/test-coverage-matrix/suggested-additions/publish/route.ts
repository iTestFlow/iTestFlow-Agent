import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

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
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Selected project, user story, and suggested test cases are required." },
      { status: 400 },
    );
  }

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const results = [];

    for (const testCase of parsed.data.testCases) {
      const created = await adapter.createTestCase({
        projectId: parsed.data.scope.azureProjectId,
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
        projectId: parsed.data.scope.azureProjectId,
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
      projectId: parsed.data.scope.projectId,
      azureProjectId: parsed.data.scope.azureProjectId,
      azureProjectName: parsed.data.scope.azureProjectName,
      azureOrganizationUrl: parsed.data.scope.azureOrganizationUrl,
      entityType: "work_item",
      entityId: parsed.data.targetWorkItemId,
      action: "test_coverage_matrix.publish_suggested_additions",
      status: results.every((result) => result.success) ? "Success" : "Partial failure",
      message: `Created and linked ${results.filter((result) => result.success).length} of ${parsed.data.testCases.length} suggested test cases.`,
      details: { results },
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Suggested additions publish failed." },
      { status: 503 },
    );
  }
}

function normalizeTestCasePriority(value: unknown) {
  if (value === 1 || value === "1" || value === "critical") return 1;
  if (value === 2 || value === "2" || value === "high") return 2;
  if (value === 3 || value === "3" || value === "medium") return 3;
  if (value === 4 || value === "4" || value === "low") return 4;
  if (value === undefined || value === null || value === "") return 2;
  return value;
}
