import { contextSelectionPrompt } from "./context-selection.prompt";
import { existingTestCaseReviewPrompt } from "./existing-test-case-review.prompt";
import { jsonRepairPrompt } from "./json-repair.prompt";
import {
  projectKnowledgeConsolidationPrompt,
  projectKnowledgeExtractionPrompt,
} from "./project-knowledge-extraction.prompt";
import { requirementAnalysisPrompt } from "./requirement-analysis.prompt";
import { structuredOutputPrompt } from "./structured-output.prompt";
import { testCaseGenerationPrompt } from "./test-case-generation.prompt";

export const llmPromptRegistry = {
  contextSelection: contextSelectionPrompt,
  existingTestCaseReview: existingTestCaseReviewPrompt,
  jsonRepair: jsonRepairPrompt,
  projectKnowledgeConsolidation: projectKnowledgeConsolidationPrompt,
  projectKnowledgeExtraction: projectKnowledgeExtractionPrompt,
  requirementAnalysis: requirementAnalysisPrompt,
  structuredOutput: structuredOutputPrompt,
  testCaseGeneration: testCaseGenerationPrompt,
} as const;

export type LlmPromptKey = keyof typeof llmPromptRegistry;

export function getLlmPrompt(key: LlmPromptKey) {
  return llmPromptRegistry[key];
}
