import { z } from "zod";

export const TestCaseStepSchema = z.object({
  index: z.number().int().positive(),
  action: z.string().min(1),
  expectedResult: z.string().min(1),
});

export const GeneratedTestCaseSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  preconditions: z.string().optional(),
  steps: z.array(TestCaseStepSchema).min(1),
  testData: z.string().optional(),
  expectedResult: z.string().min(1),
  priority: z.enum(["High", "Medium", "Low"]),
  severity: z.enum(["High", "Medium", "Low"]),
  testType: z.enum([
    "Functional",
    "Negative",
    "Edge case",
    "Integration",
    "Regression",
    "API",
    "UI",
    "Security",
    "Performance",
    "Accessibility",
  ]),
  automationSuitability: z.enum(["High", "Medium", "Low"]),
  relatedAcceptanceCriteria: z.array(z.string()).default([]),
  relatedBusinessRules: z.array(z.string()).default([]),
  relatedRisks: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export const TestCaseGenerationOutputSchema = z.object({
  summary: z.string(),
  testCases: z.array(GeneratedTestCaseSchema),
});

export type GeneratedTestCase = z.infer<typeof GeneratedTestCaseSchema>;
export type TestCaseGenerationOutput = z.infer<typeof TestCaseGenerationOutputSchema>;
