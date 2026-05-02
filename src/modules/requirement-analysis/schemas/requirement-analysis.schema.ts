import { z } from "zod";

export const RequirementAnalysisFindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["High", "Medium", "Low"]),
  category: z.string(),
  title: z.string(),
  explanation: z.string(),
  suggestedImprovement: z.string(),
  azureDevOpsCommentSnippet: z.string(),
  scoreImpact: z.number(),
  sourceContextIds: z.array(z.string()).default([]),
});

export const RequirementAnalysisOutputSchema = z.object({
  executiveSummary: z.string(),
  scores: z.object({
    clarity: z.number().min(0).max(100),
    testability: z.number().min(0).max(100),
    completeness: z.number().min(0).max(100),
    ambiguityRisk: z.number().min(0).max(100),
    integrationRisk: z.number().min(0).max(100),
    businessRuleCoverage: z.number().min(0).max(100),
    acceptanceCriteriaQuality: z.number().min(0).max(100),
    overallReadiness: z.number().min(0).max(100),
  }),
  findings: z.array(RequirementAnalysisFindingSchema),
  assumptions: z.array(z.string()).default([]),
  questionsForProductOwner: z.array(z.string()).default([]),
});

export type RequirementAnalysisOutput = z.infer<typeof RequirementAnalysisOutputSchema>;
