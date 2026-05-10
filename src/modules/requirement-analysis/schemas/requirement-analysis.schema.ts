import { z } from "zod";

export const RequirementFindingTypeSchema = z.enum([
  "ambiguity",
  "conflict",
  "missing_requirement",
  "incomplete_criteria",
  "inconsistency",
  "security_concern",
  "performance_concern",
  "ux_issue",
  "dependency_issue",
  "business_rule_violation",
]);

export const RequirementFindingSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export const RequirementRiskLevelSchema = z.enum(["high", "medium", "low"]);

export const RequirementFindingReferenceSchema = z.object({
  module: z.string().optional(),
  section: z.string().optional(),
  sourceId: z.string().optional(),
  description: z.string().optional(),
});

export const RequirementAnalysisFindingSchema = z.object({
  id: z.string(),
  type: RequirementFindingTypeSchema,
  severity: RequirementFindingSeveritySchema,
  title: z.string(),
  description: z.string(),
  suggestion: z.string(),
  riskLevel: RequirementRiskLevelSchema,
  riskJustification: z.string(),
  affectedAreas: z.array(z.string()).default([]),
  references: z.array(RequirementFindingReferenceSchema).default([]),
  contradiction: z.boolean().default(false),
});

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
  contextUsed: z.array(z.string()).default([]),
});

export type RequirementAnalysisOutput = z.infer<typeof RequirementAnalysisOutputSchema>;
