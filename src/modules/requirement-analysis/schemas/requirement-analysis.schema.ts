import { z } from "zod";
import { ContextUsedSchema } from "@/modules/llm/context-used";
import { requirementAnalysisChecklistItemIdValues } from "@/modules/requirement-analysis/checklist-options";
import {
  requirementFindingSeverityValues,
  requirementIssueTypeValues,
  requirementRiskLevelValues,
} from "@/modules/requirement-analysis/finding-options";

export const RequirementIssueTypeSchema = z.enum(requirementIssueTypeValues);
export const RequirementFindingSeveritySchema = z.enum(requirementFindingSeverityValues);
export const RequirementRiskLevelSchema = z.enum(requirementRiskLevelValues);

export const RequirementFindingReferenceSchema = z.object({
  module: z.string().optional(),
  section: z.string().optional(),
  sourceId: z.string().optional(),
  description: z.string().optional(),
});

export const RequirementAnalysisFindingSchema = z.object({
  id: z.string(),
  checklistItemId: z.enum(requirementAnalysisChecklistItemIdValues),
  issueType: RequirementIssueTypeSchema,
  severity: RequirementFindingSeveritySchema,
  title: z.string(),
  description: z.string(),
  suggestion: z.string(),
  riskLevel: RequirementRiskLevelSchema,
  riskJustification: z.string(),
  affectedAreas: z.array(z.string()).default([]),
  references: z.array(RequirementFindingReferenceSchema).default([]),
  contradiction: z.boolean().default(false),
}).strict();

export const RequirementAnalysisSummarySchema = z.object({
  totalFindings: z.number().int().min(0),
  criticalCount: z.number().int().min(0),
  highCount: z.number().int().min(0),
  mediumCount: z.number().int().min(0),
  lowCount: z.number().int().min(0),
  infoCount: z.number().int().min(0),
  overallQuality: z.enum(["poor", "fair", "good", "excellent"]),
  completenessScore: z.number().min(0).max(100),
  clarityScore: z.number().min(0).max(100),
  testabilityScore: z.number().min(0).max(100),
  summaryText: z.string(),
});

export const RequirementAnalysisOutputSchema = z.object({
  findings: z.array(RequirementAnalysisFindingSchema),
  summary: RequirementAnalysisSummarySchema,
  recommendations: z.array(z.string()).default([]),
  questionsForProductOwner: z.array(z.string()).default([]),
  contextUsed: ContextUsedSchema,
});

export type RequirementAnalysisOutput = z.infer<typeof RequirementAnalysisOutputSchema>;
