import { NextResponse } from "next/server";
import { z } from "zod";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import type { FinalApprovedTestCase } from "@/modules/integrations/azure-devops/azure-devops-types";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

export const runtime = "nodejs";

const TestCasePrioritySchema = z.preprocess(
  normalizeTestCasePriority,
  z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
);

const ReproductionTestCaseSchema = z.object({
  id: z.string().trim().optional(),
  localId: z.string().trim().optional(),
  targetUserStoryId: z.string().trim().optional(),
  title: z.string().trim().min(1),
  description: z.string().trim().optional().default(""),
  priority: TestCasePrioritySchema,
  type: z.string().trim().optional(),
  category: z.string().trim().optional(),
  relatedAcceptanceCriteria: z.array(z.string()).optional().default([]),
  relatedBusinessRules: z.array(z.string()).optional().default([]),
  relatedModules: z.array(z.string()).optional().default([]),
  preconditions: z.string().trim().optional().default(""),
  testData: z.string().trim().optional().default(""),
  expectedResult: z.string().trim().optional(),
  steps: z.array(z.object({
    stepNumber: z.number().int().positive().optional(),
    action: z.string().trim().min(1),
    expectedResult: z.string().trim().min(1),
  })).min(1),
});

const RequestSchema = z
  .object({
    scope: ProjectScopeSchema,
    parentStoryId: z.string().trim().min(1),
    bugId: z.string().trim().min(1),
    selectedTestCaseId: z.string().trim().optional(),
    suggestedTestCase: ReproductionTestCaseSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const hasSelected = Boolean(value.selectedTestCaseId);
    const hasSuggested = Boolean(value.suggestedTestCase);
    if (hasSelected === hasSuggested) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedTestCaseId"],
        message: "Choose either an existing linked test case or one suggested reproduction test case.",
      });
    }
  });

type PublishStepResult = { success: boolean; error?: string };

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Bug, user story, and test case details are required." },
      { status: 400 },
    );
  }

  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const create: PublishStepResult & { azureTestCaseId?: string } = parsed.data.suggestedTestCase
      ? await adapter.createTestCase({
          projectId: parsed.data.scope.azureProjectId,
          testCase: toFinalApprovedTestCase(parsed.data.suggestedTestCase, parsed.data.parentStoryId),
        })
      : { success: true, azureTestCaseId: parsed.data.selectedTestCaseId };

    const azureTestCaseId = create.azureTestCaseId ?? parsed.data.selectedTestCaseId;
    const storyLink: PublishStepResult = parsed.data.suggestedTestCase && azureTestCaseId
      ? await adapter.linkTestCaseToUserStory({
          projectId: parsed.data.scope.azureProjectId,
          userStoryId: parsed.data.parentStoryId,
          azureTestCaseId,
        })
      : { success: true };
    const bugLink: PublishStepResult = create.success && storyLink.success && azureTestCaseId
      ? await adapter.linkTestCaseToWorkItem({
          projectId: parsed.data.scope.azureProjectId,
          workItemId: parsed.data.bugId,
          azureTestCaseId,
        })
      : { success: false, error: "Skipped because test case creation or user story linking failed." };
    const success = create.success && storyLink.success && bugLink.success;
    const result = {
      mode: parsed.data.suggestedTestCase ? "suggested" : "existing",
      azureTestCaseId,
      success,
      create,
      storyLink,
      bugLink,
      error: create.error ?? storyLink.error ?? bugLink.error,
    };

    writeAuditLog({
      projectId: parsed.data.scope.projectId,
      azureProjectId: parsed.data.scope.azureProjectId,
      azureProjectName: parsed.data.scope.azureProjectName,
      azureOrganizationUrl: parsed.data.scope.azureOrganizationUrl,
      entityType: "work_item",
      entityId: parsed.data.bugId,
      action: "bug_report.link_reproduction_test_case",
      status: success ? "Success" : "Partial failure",
      message: success
        ? `Linked test case ${azureTestCaseId} to Bug ${parsed.data.bugId}.`
        : `Could not fully link the reproduction test case to Bug ${parsed.data.bugId}.`,
      details: {
        parentStoryId: parsed.data.parentStoryId,
        selectedTestCaseId: parsed.data.selectedTestCaseId,
        result,
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reproduction test case publish failed." },
      { status: 503 },
    );
  }
}

function toFinalApprovedTestCase(
  testCase: z.infer<typeof ReproductionTestCaseSchema>,
  targetUserStoryId: string,
): FinalApprovedTestCase {
  return {
    localId: testCase.localId || testCase.id || "bug-reproduction-test-case",
    targetUserStoryId,
    title: testCase.title,
    description: testCase.description,
    priority: testCase.priority,
    testType: testCase.type,
    automationSuitability: undefined,
    tags: ["bug-reproduction", "regression"],
    preconditions: testCase.preconditions,
    testData: testCase.testData,
    expectedResult: testCase.expectedResult,
    steps: testCase.steps.map((step) => ({
      action: step.action,
      expectedResult: step.expectedResult,
    })),
  };
}

function normalizeTestCasePriority(value: unknown) {
  if (value === 1 || value === "1" || value === "critical") return 1;
  if (value === 2 || value === "2" || value === "high") return 2;
  if (value === 3 || value === "3" || value === "medium") return 3;
  if (value === 4 || value === "4" || value === "low") return 4;
  if (value === undefined || value === null || value === "") return 2;
  return value;
}
