import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getConfiguredAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { publishApprovedTestCases } from "@/modules/integrations/azure-devops/azure-devops-test-plan.service";

export const runtime = "nodejs";

const FinalApprovedTestCaseSchema = z.object({
  localId: z.string().min(1),
  targetUserStoryId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  preconditions: z.string().optional(),
  steps: z.array(z.object({ action: z.string().min(1), expectedResult: z.string().min(1) })).min(1),
  testData: z.string().optional(),
  expectedResult: z.string().optional(),
  priority: z.string().optional(),
  severity: z.string().optional(),
  testType: z.string().optional(),
  automationSuitability: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  testPlanId: z.string().min(1),
  testSuiteId: z.string().min(1),
  testCases: z.array(FinalApprovedTestCaseSchema).min(1),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Selected project, target story, test plan, test suite, and selected test cases are required." }, { status: 400 });
  }

  try {
    const adapter = getConfiguredAzureDevOpsAdapter();
    const results = await publishApprovedTestCases(adapter, parsed.data.scope, {
      targetUserStoryId: parsed.data.targetWorkItemId,
      testPlanId: parsed.data.testPlanId,
      testSuiteId: parsed.data.testSuiteId,
      testCases: parsed.data.testCases,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      testPlanId: parsed.data.testPlanId,
      testSuiteId: parsed.data.testSuiteId,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure Test Plan publish failed." },
      { status: 503 },
    );
  }
}
