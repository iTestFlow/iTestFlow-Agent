import type { RequirementAnalysisChecklistItemId } from "@/modules/requirement-analysis/checklist-options";
import type { TestDesignOptions } from "@/modules/test-case-design/test-design-options";

/**
 * Shared client-side types for the AI test-intelligence workflows (Requirement
 * Analysis, Test Case Design, Test Coverage Matrix). Extracted verbatim from the
 * former `live-workflows.tsx` monolith so the per-route client files and the
 * shared workflow components can reference one canonical set. These mirror the
 * API response/request shapes — do not rename fields.
 */

export type ApiState<T> = {
  loading: boolean;
  error: string | null;
  data: T | null;
};

export type WorkflowMode = "auto" | "manual";

export type RequirementFinding = {
  id: string;
  checklistItemId: RequirementAnalysisChecklistItemId;
  issueType: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  title: string;
  description: string;
  suggestion: string;
  riskLevel: "high" | "medium" | "low";
  riskJustification: string;
  affectedAreas: string[];
  references: Array<{ module?: string; section?: string; sourceId?: string; description?: string }>;
  contradiction: boolean;
};

export type RequirementSummary = {
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  infoCount: number;
  overallQuality: "poor" | "fair" | "good" | "excellent";
  completenessScore: number;
  clarityScore: number;
  testabilityScore: number;
  summaryText: string;
};

export type RequirementAnalysisRunResult = {
  findings: RequirementFinding[];
  summary: RequirementSummary;
  recommendations: string[];
  contextUsed: string[];
  enabledChecklistItemIds?: RequirementAnalysisChecklistItemId[];
  resolvedContextUsed?: unknown[];
};

export type GeneratedTestCase = {
  id: string;
  title: string;
  description: string;
  priority: 1 | 2 | 3 | 4;
  type: string;
  category: string;
  tags?: string[];
  relatedAcceptanceCriteria?: string[];
  relatedBusinessRules?: string[];
  relatedModules?: string[];
  preconditions: string;
  testData?: string;
  steps: Array<{ stepNumber: number; action: string; expectedResult: string }>;
};

export type TestCaseSummary = {
  totalCases: number;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
  coverageEstimate: number;
};

export type TestCaseGenerationRunResult = {
  testCases: GeneratedTestCase[];
  summary: TestCaseSummary;
  contextUsed: string[];
  resolvedContextUsed?: unknown[];
  options?: TestDesignOptions;
};

export type ManualPromptDraft = {
  prompt: string;
  promptVersion: string;
  enabledChecklistItemIds?: RequirementAnalysisChecklistItemId[];
  options?: TestDesignOptions;
  selectedContextIds?: string[];
  resolvedContextUsed?: unknown[];
  retrievalTopK?: number;
};

export type TestPlan = {
  id: string;
  name: string;
};

export type TestSuite = {
  id: string;
  name: string;
  planId: string;
};

export type ExistingLinkedTestCase = {
  id: string;
  title: string;
  testType?: string;
  automationSuitability?: string;
  steps?: unknown[];
};

export type ExistingTraceabilityRow = {
  id: string;
  sourceType: "story" | "description" | "acceptanceCriteria" | "businessRules";
  sourceReference: string;
  requirementText: string;
  coverageStatus: "Covered" | "Partially covered" | "Not covered" | "Needs review";
  severity: "High" | "Medium" | "Low";
  linkedTestCaseIds: string[];
  evidenceSummary: string;
  missingCoverage: string;
  recommendedMinimumTestCount: number;
  recommendedAction: string;
};

export type ExistingReviewInsight = {
  id: string;
  severity: "High" | "Medium" | "Low";
  title: string;
  explanation: string;
  relatedMatrixRowIds: string[];
  relatedTestCaseIds: string[];
  suggestedAction: string;
};

export type ExistingReviewFinding = {
  id: string;
  severity: "High" | "Medium" | "Low";
  category: string;
  title: string;
  explanation: string;
  relatedMatrixRowIds?: string[];
  relatedTestCaseIds?: string[];
  suggestedAction: string;
};

export type ExistingReviewResult = {
  summary: string;
  coverageScore: number;
  traceabilityMatrix: ExistingTraceabilityRow[];
  insights: ExistingReviewInsight[];
  linkedTestCases: ExistingLinkedTestCase[];
  findings: ExistingReviewFinding[];
  suggestedAdditions: GeneratedTestCase[];
  contextUsed: string[];
};

export type PublishRunResult = {
  results: Array<{
    localId: string;
    azureTestCaseId?: string;
    success: boolean;
    create?: { success: boolean; error?: string };
    link?: { success: boolean; error?: string };
    suite?: { success: boolean; suiteId?: string; suiteName?: string; error?: string };
    error?: string;
  }>;
  requirementSuite?: { success: boolean; suiteId?: string; suiteName?: string; error?: string };
};

export type SuggestedAdditionsPublishResult = {
  results: Array<{
    localId: string;
    azureTestCaseId?: string;
    success: boolean;
    create?: { success: boolean; error?: string };
    link?: { success: boolean; error?: string };
    error?: string;
  }>;
};
