import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { getProjectScopedAzureDevOpsAdapter } from "@/modules/integrations/azure-devops/configured-azure-devops";
import { publishApprovedTestCases } from "@/modules/integrations/azure-devops/azure-devops-test-plan.service";

export const runtime = "nodejs";

const TestCasePrioritySchema = z.preprocess(
  normalizeTestCasePriority,
  z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
);

const FinalApprovedTestCaseSchema = z.object({
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
  testPlanId: azureIdSchema("plan").optional(),
  testSuiteId: azureIdSchema("suite").optional(),
  parentSuiteId: azureIdSchema("suite").optional(),
  suiteMode: z.enum(["existing", "requirement", "none"]).default("existing"),
  testCases: z.array(FinalApprovedTestCaseSchema).min(1),
}).superRefine((value, ctx) => {
  if (value.suiteMode !== "none" && !value.testPlanId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["testPlanId"],
      message: "Select or enter an Azure Test Plan ID before publishing to a suite.",
    });
  }

  if (value.suiteMode === "existing" && !value.testSuiteId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["testSuiteId"],
      message: "Select or enter an existing Test Suite ID before publishing.",
    });
  }

  if (value.suiteMode === "requirement" && !value.parentSuiteId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["parentSuiteId"],
      message: "Select or enter the parent suite ID for the requirement-based suite.",
    });
  }

  if (value.suiteMode === "requirement" && !/^\d+$/.test(value.targetWorkItemId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetWorkItemId"],
      message: "Requirement-based suites require a numeric Azure User Story work item ID.",
    });
  }
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Selected project, target story, and selected test cases are required." },
      { status: 400 },
    );
  }

  try {
    const adapter = getProjectScopedAzureDevOpsAdapter(parsed.data.scope);
    const result = await publishApprovedTestCases(adapter, parsed.data.scope, {
      targetUserStoryId: parsed.data.targetWorkItemId,
      testPlanId: parsed.data.testPlanId,
      testSuiteId: parsed.data.testSuiteId,
      parentSuiteId: parsed.data.parentSuiteId,
      suiteMode: parsed.data.suiteMode,
      testCases: parsed.data.testCases,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      testPlanId: parsed.data.testPlanId,
      testSuiteId: parsed.data.testSuiteId,
      parentSuiteId: parsed.data.parentSuiteId,
      suiteMode: parsed.data.suiteMode,
      ...result,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Azure Test Plan publish failed." },
      { status: 503 },
    );
  }
}

function azureIdSchema(kind: "plan" | "suite") {
  return z.string().min(1).transform((value, ctx) => {
    const id = extractAzureId(value, kind);
    if (!id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Enter a valid Azure Test ${kind === "plan" ? "Plan" : "Suite"} ID or URL.`,
      });
      return z.NEVER;
    }

    return id;
  });
}

function extractAzureId(value: string, kind: "plan" | "suite") {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;

  const queryPattern = kind === "plan" ? /[?&]planId=(\d+)/i : /[?&]suiteId=(\d+)/i;
  const pathPattern = kind === "plan" ? /\/plans\/(\d+)(?:\/|$|\?)/i : /\/suites\/(\d+)(?:\/|$|\?)/i;
  return trimmed.match(queryPattern)?.[1] ?? trimmed.match(pathPattern)?.[1];
}

function normalizeTestCasePriority(value: unknown) {
  if (value === 1 || value === "1" || value === "critical") return 1;
  if (value === 2 || value === "2" || value === "high") return 2;
  if (value === 3 || value === "3" || value === "medium") return 3;
  if (value === 4 || value === "4" || value === "low") return 4;
  if (value === undefined || value === null || value === "") return 2;
  return value;
}
