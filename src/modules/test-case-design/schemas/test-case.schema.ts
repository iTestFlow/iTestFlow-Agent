import { z } from "zod";
import { ContextUsedSchema } from "@/modules/llm/context-used";

export const TestCasePrioritySchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const TestCaseTypeSchema = z.enum([
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
]);

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
