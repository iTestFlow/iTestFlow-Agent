import { z } from "zod";
import { ContextUsedSchema } from "@/modules/llm/context-used";
import { GeneratedTestCaseSchema } from "@/modules/test-case-design/schemas/test-case.schema";

export const ExistingTestCaseCoverageStatusSchema = z.enum([
  "Covered",
  "Partially covered",
  "Not covered",
  "Needs review",
]);

export const ExistingTestCaseReviewSeveritySchema = z.enum(["High", "Medium", "Low"]);

export const ExistingTestCaseSourceTypeSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().replace(/[\s_-]+/g, "").toLowerCase();
    if (normalized === "acceptancecriteria") return "acceptanceCriteria";
    if (normalized === "businessrule" || normalized === "businessrules") return "businessRules";
    return value;
  },
  z.enum(["story", "description", "acceptanceCriteria", "businessRules"]),
);

export const ExistingTestCaseTraceabilityMatrixRowSchema = z.object({
  id: z.string(),
  sourceType: ExistingTestCaseSourceTypeSchema,
  sourceReference: z.string(),
  requirementText: z.string(),
  coverageStatus: ExistingTestCaseCoverageStatusSchema,
  severity: ExistingTestCaseReviewSeveritySchema,
  linkedTestCaseIds: z.array(z.string()).default([]),
  evidenceSummary: z.string().default(""),
  missingCoverage: z.string().default(""),
  recommendedMinimumTestCount: z.number().int().min(0),
  recommendedAction: z.string(),
});

export const ExistingTestCaseReviewInsightSchema = z.object({
  id: z.string(),
  severity: ExistingTestCaseReviewSeveritySchema,
  title: z.string(),
  explanation: z.string(),
  relatedMatrixRowIds: z.array(z.string()).default([]),
  relatedTestCaseIds: z.array(z.string()).default([]),
  suggestedAction: z.string(),
});

export const ExistingTestCaseReviewFindingSchema = z.object({
  id: z.string(),
  category: z.enum([
    "Missing coverage",
    "Duplicate",
    "Weak steps",
    "Weak expected result",
    "Missing preconditions",
    "Missing test data",
    "Automation readiness",
  ]),
  severity: ExistingTestCaseReviewSeveritySchema,
  title: z.string(),
  explanation: z.string(),
  relatedMatrixRowIds: z.array(z.string()).default([]),
  relatedTestCaseIds: z.array(z.string()).default([]),
  suggestedAction: z.string(),
});

export const ExistingTestCaseReviewOutputSchema = z.object({
  summary: z.string(),
  coverageScore: z.number().min(0).max(100),
  traceabilityMatrix: z.array(ExistingTestCaseTraceabilityMatrixRowSchema),
  insights: z.array(ExistingTestCaseReviewInsightSchema).default([]),
  findings: z.array(ExistingTestCaseReviewFindingSchema),
  suggestedAdditions: z.array(GeneratedTestCaseSchema),
  contextUsed: ContextUsedSchema,
});

export type ExistingTestCaseReviewOutput = z.infer<typeof ExistingTestCaseReviewOutputSchema>;
