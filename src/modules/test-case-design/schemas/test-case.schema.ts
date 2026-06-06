import { z } from "zod";
import { ContextUsedSchema } from "@/modules/llm/context-used";

export const TestCasePrioritySchema = z.preprocess(
  (value) => {
    if (typeof value !== "string" || !/^[1-4]$/.test(value.trim())) return value;
    return Number(value.trim());
  },
  z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
);
const testCaseTypeValues = [
  "functional",
  "smoke",
  "sanity",
  "regression",
  "e2e",
  "integration",
  "unit",
  "api",
  "ui",
  "security",
  "performance",
  "accessibility",
] as const;

const testCaseTypeAliases: Record<string, (typeof testCaseTypeValues)[number]> = {
  regression_impact: "regression",
  integration_api: "integration",
  security_permissions: "security",
  data_validation: "functional",
  edge_negative: "functional",
  edge_cases_negative_scenarios: "functional",
  ui_interaction: "ui",
  ui_interaction_behavior: "ui",
  responsive_layout: "ui",
  localization_language_rtl_ltr: "ui",
  localization_language_and_rtl_ltr: "ui",
  end_to_end: "e2e",
};

export const TestCaseTypeSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (testCaseTypeValues.includes(normalized as (typeof testCaseTypeValues)[number])) return normalized;
    return testCaseTypeAliases[normalized] ?? value;
  },
  z.enum(testCaseTypeValues),
);

export const TestCaseStepSchema = z.object({
  stepNumber: z.number().int().positive(),
  action: z.string().min(1),
  expectedResult: z.string().min(1),
});

export const GeneratedTestCaseSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().min(1),
  priority: TestCasePrioritySchema,
  type: TestCaseTypeSchema,
  category: z.string().min(1),
  tags: z.array(z.string()).default([]),
  relatedAcceptanceCriteria: z.array(z.string()).default([]),
  relatedBusinessRules: z.array(z.string()).default([]),
  relatedModules: z.array(z.string()).default([]),
  preconditions: z.string().min(1),
  testData: z.string().optional().default(""),
  steps: z.array(TestCaseStepSchema).min(1),
}).superRefine((testCase, ctx) => {
  const firstStep = testCase.steps[0];
  if (firstStep?.stepNumber !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps", 0, "stepNumber"],
      message: "The first step must have stepNumber 1.",
    });
  }
  if (!firstStep?.action.trim().toLowerCase().startsWith("preconditions")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps", 0, "action"],
      message: "The first step action must start with Preconditions.",
    });
  }
  if (firstStep?.expectedResult !== "Preconditions are met") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["steps", 0, "expectedResult"],
      message: "The first step expectedResult must be Preconditions are met.",
    });
  }
});

export const TestCaseGenerationSummarySchema = z.object({
  totalCases: z.number().int().min(0),
  byType: z.record(z.number().int().min(0)).default({}),
  byPriority: z.record(z.number().int().min(0)).default({}),
  coverageEstimate: z.number().min(0).max(100),
});

export const TestCaseGenerationOutputSchema = z.object({
  testCases: z.array(GeneratedTestCaseSchema),
  summary: TestCaseGenerationSummarySchema,
  contextUsed: ContextUsedSchema,
});

export type GeneratedTestCase = z.infer<typeof GeneratedTestCaseSchema>;
export type TestCaseGenerationOutput = z.infer<typeof TestCaseGenerationOutputSchema>;
