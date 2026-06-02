import { z } from "zod";

export const TesterSenioritySchema = z.enum(["junior", "mid", "senior"]);
export const ExecutionTypeSchema = z.enum(["first_execution", "regression_reexecution", "uat_support"]);

export const TestExecutionEffortOptionsSchema = z.object({
  testerSeniority: TesterSenioritySchema.default("mid"),
  executionType: ExecutionTypeSchema.default("first_execution"),
  includeDataPreparation: z.boolean().default(true),
  includeEnvironmentSetup: z.boolean().default(true),
  includeEvidenceAndDefectLogging: z.boolean().default(true),
  includeRetestingBuffer: z.boolean().default(true),
});

export const StoryIdSchema = z.string().trim().regex(/^\d+$/, "Enter a valid numeric User Story ID.");

export type TesterSeniority = z.infer<typeof TesterSenioritySchema>;
export type ExecutionType = z.infer<typeof ExecutionTypeSchema>;
export type TestExecutionEffortOptions = z.infer<typeof TestExecutionEffortOptionsSchema>;

export const ComplexityLevelSchema = z.enum(["Low", "Medium", "High"]);
export const TestCaseComplexitySchema = z.enum(["Simple", "Medium", "Complex"]);
export const EstimateConfidenceSchema = z.enum(["Low", "Medium", "High"]);

const NonNegativeNumberSchema = z.number().finite().min(0);

export const TestExecutionEffortOutputSchema = z.object({
  story: z.object({
    id: z.string(),
    title: z.string(),
    workItemType: z.string(),
    state: z.string(),
  }),
  executionProfile: z.object({
    testerSeniority: TesterSenioritySchema,
    executionType: ExecutionTypeSchema,
    includedFactors: z.object({
      dataPreparation: z.boolean(),
      environmentSetup: z.boolean(),
      evidenceAndDefectLogging: z.boolean(),
      retestingBuffer: z.boolean(),
    }),
  }),
  statistics: z.object({
    testCaseCount: NonNegativeNumberSchema,
    totalSteps: NonNegativeNumberSchema,
    averageStepsPerTestCase: NonNegativeNumberSchema,
    simpleTestCases: NonNegativeNumberSchema,
    mediumTestCases: NonNegativeNumberSchema,
    complexTestCases: NonNegativeNumberSchema,
    testCasesWithMissingSteps: NonNegativeNumberSchema,
    integrationPointsCount: NonNegativeNumberSchema,
    dataPreparationComplexity: ComplexityLevelSchema,
    environmentSetupComplexity: ComplexityLevelSchema,
    executionComplexity: ComplexityLevelSchema,
  }),
  estimate: z.object({
    minimumHours: NonNegativeNumberSchema,
    mostLikelyHours: NonNegativeNumberSchema,
    maximumHours: NonNegativeNumberSchema,
    recommendedPlanningHours: NonNegativeNumberSchema,
    confidence: EstimateConfidenceSchema,
    confidenceReason: z.string(),
  }).superRefine((estimate, context) => {
    if (estimate.mostLikelyHours < estimate.minimumHours) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mostLikelyHours"],
        message: "mostLikelyHours must be greater than or equal to minimumHours.",
      });
    }
    if (estimate.maximumHours < estimate.mostLikelyHours) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maximumHours"],
        message: "maximumHours must be greater than or equal to mostLikelyHours.",
      });
    }
    if (estimate.recommendedPlanningHours < estimate.mostLikelyHours) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recommendedPlanningHours"],
        message: "recommendedPlanningHours should be greater than or equal to mostLikelyHours.",
      });
    }
  }),
  breakdown: z.array(z.object({
    area: z.string(),
    estimatedHours: NonNegativeNumberSchema,
    reason: z.string(),
  })),
  testCaseEstimates: z.array(z.object({
    testCaseId: z.string(),
    title: z.string(),
    stepsCount: NonNegativeNumberSchema,
    complexity: TestCaseComplexitySchema,
    executionMinutes: NonNegativeNumberSchema,
    dataPreparationMinutes: NonNegativeNumberSchema,
    environmentSetupMinutes: NonNegativeNumberSchema,
    integrationValidationMinutes: NonNegativeNumberSchema,
    evidenceAndDefectLoggingMinutes: NonNegativeNumberSchema,
    retestingBufferMinutes: NonNegativeNumberSchema,
    totalEstimatedMinutes: NonNegativeNumberSchema,
    reason: z.string(),
  })),
  assumptions: z.array(z.string()),
  risksThatMayIncreaseTime: z.array(z.string()),
  recommendations: z.array(z.string()),
});

export type TestExecutionEffortOutput = z.infer<typeof TestExecutionEffortOutputSchema>;

export const TEST_EXECUTION_EFFORT_OUTPUT_CONTRACT = {
  story: {
    id: "string",
    title: "string",
    workItemType: "string",
    state: "string",
  },
  executionProfile: {
    testerSeniority: "junior | mid | senior",
    executionType: "first_execution | regression_reexecution | uat_support",
    includedFactors: {
      dataPreparation: true,
      environmentSetup: true,
      evidenceAndDefectLogging: true,
      retestingBuffer: true,
    },
  },
  statistics: {
    testCaseCount: 0,
    totalSteps: 0,
    averageStepsPerTestCase: 0,
    simpleTestCases: 0,
    mediumTestCases: 0,
    complexTestCases: 0,
    testCasesWithMissingSteps: 0,
    integrationPointsCount: 0,
    dataPreparationComplexity: "Low | Medium | High",
    environmentSetupComplexity: "Low | Medium | High",
    executionComplexity: "Low | Medium | High",
  },
  estimate: {
    minimumHours: 0,
    mostLikelyHours: 0,
    maximumHours: 0,
    recommendedPlanningHours: 0,
    confidence: "Low | Medium | High",
    confidenceReason: "string",
  },
  breakdown: [
    {
      area: "string",
      estimatedHours: 0,
      reason: "string",
    },
  ],
  testCaseEstimates: [
    {
      testCaseId: "string",
      title: "string",
      stepsCount: 0,
      complexity: "Simple | Medium | Complex",
      executionMinutes: 0,
      dataPreparationMinutes: 0,
      environmentSetupMinutes: 0,
      integrationValidationMinutes: 0,
      evidenceAndDefectLoggingMinutes: 0,
      retestingBufferMinutes: 0,
      totalEstimatedMinutes: 0,
      reason: "string",
    },
  ],
  assumptions: ["string"],
  risksThatMayIncreaseTime: ["string"],
  recommendations: ["string"],
} as const;

