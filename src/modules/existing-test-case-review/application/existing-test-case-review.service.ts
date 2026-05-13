import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { parseExternalStructuredOutput } from "@/modules/llm/external-structured-output";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
import { buildExistingTestCaseReviewMarkdownPrompt, extractWorkItemId } from "@/modules/llm/markdown-prompt-renderer";
import { existingTestCaseReviewPrompt } from "@/modules/llm/prompts";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { ExistingTestCaseReviewOutputSchema } from "../schemas/existing-test-case-review.schema";

export async function reviewExistingLinkedTestCases(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: unknown;
  linkedTestCases: unknown[];
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
}) {
  const scope = assertProjectScope(input.scope);
  const promptDraft = buildExistingTestCaseReviewPromptDraft({
    scope,
    targetRequirement: input.targetRequirement,
    linkedTestCases: input.linkedTestCases,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
  });
  const result = await input.provider.generateStructuredOutput({
    schemaName: promptDraft.schemaName,
    schema: ExistingTestCaseReviewOutputSchema,
    system: promptDraft.systemPrompt,
    user: promptDraft.userPrompt,
    maxTokens: 12000,
    metadata: {
      action: "existing_test_case_review.run",
      promptName: existingTestCaseReviewPrompt.name,
      promptVersion: existingTestCaseReviewPrompt.version,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      targetWorkItemId: extractWorkItemId(input.targetRequirement),
    },
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "existing_test_case_review.run",
    status: "Success",
    message: `Built a Test Coverage Matrix from ${input.linkedTestCases.length} linked Azure DevOps test cases.`,
    details: {
      provider: result.provider,
      model: result.model,
      promptVersion: existingTestCaseReviewPrompt.version,
    },
  });

  return result;
}

export function buildExistingTestCaseReviewPromptDraft(input: {
  scope: ProjectScope;
  targetRequirement: unknown;
  linkedTestCases: unknown[];
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
}) {
  const scope = assertProjectScope(input.scope);
  const promptPayload = buildExistingTestCaseReviewMarkdownPrompt({
    currentProject: {
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
    },
    targetRequirement: input.targetRequirement,
    linkedTestCases: input.linkedTestCases,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    outputContract: existingTestCaseReviewOutputContract,
  });

  return {
    schemaName: "ExistingTestCaseReviewOutput",
    promptName: existingTestCaseReviewPrompt.name,
    promptVersion: existingTestCaseReviewPrompt.version,
    systemPrompt: existingTestCaseReviewPrompt.system,
    userPrompt: promptPayload.prompt,
    prompt: buildManualPromptMarkdown({
      title: "iTestFlow Test Coverage Matrix",
      system: existingTestCaseReviewPrompt.system,
      user: promptPayload.prompt,
    }),
    relevantProjectKnowledgeBase: promptPayload.relevantProjectKnowledgeBase,
  };
}

export function completeManualExistingTestCaseReview(input: {
  scope: ProjectScope;
  rawOutput: string;
  targetWorkItemId?: string;
}) {
  const scope = assertProjectScope(input.scope);
  const validatedOutput = parseExternalStructuredOutput({
    schemaName: "ExistingTestCaseReviewOutput",
    schema: ExistingTestCaseReviewOutputSchema,
    rawOutput: input.rawOutput,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "existing_test_case_review.manual_complete",
    status: "Success",
    message: "Test Coverage Matrix completed from validated external LLM output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: existingTestCaseReviewPrompt.version,
      targetWorkItemId: input.targetWorkItemId,
    },
  });

  return {
    provider: "external",
    model: "manual-external",
    rawOutput: input.rawOutput,
    validatedOutput,
  };
}

const existingTestCaseReviewOutputContract = {
  summary: "Concise overall coverage summary.",
  coverageScore: "number from 0 to 100",
  traceabilityMatrix: [
    {
      id: "TM-001",
      sourceType: "story|description|acceptanceCriteria",
      sourceReference: "Title|Description paragraph 1|AC-1",
      requirementText: "One atomic testable point from the story.",
      coverageStatus: "Covered|Partially covered|Not covered|Needs review",
      severity: "High|Medium|Low",
      linkedTestCaseIds: ["Azure test case ID"],
      evidenceSummary: "What linked test cases actually validate for this point.",
      missingCoverage: "What is missing, or empty string if fully covered.",
      recommendedMinimumTestCount: 1,
      recommendedAction: "Specific next action for the user.",
    },
  ],
  insights: [
    {
      id: "INS-001",
      severity: "High|Medium|Low",
      title: "Brief insight title",
      explanation: "Grounded explanation based on matrix rows and linked test cases.",
      relatedMatrixRowIds: ["TM-001"],
      relatedTestCaseIds: ["Azure test case ID"],
      suggestedAction: "Specific next step.",
    },
  ],
  findings: [
    {
      id: "F-001",
      category:
        "Missing coverage|Duplicate|Weak steps|Weak expected result|Missing preconditions|Missing test data|Automation readiness",
      severity: "High|Medium|Low",
      title: "Brief finding title",
      explanation: "Grounded finding based only on supplied evidence.",
      relatedMatrixRowIds: ["TM-001"],
      relatedTestCaseIds: ["Azure test case ID"],
      suggestedAction: "Specific remediation.",
    },
  ],
  suggestedAdditions: [
    {
      id: "TC-GAP-001",
      title: "Validate missing behavior",
      description: "Brief description of what the test validates",
      priority: "number only: 1|2|3|4, where 1 is highest and 4 is lowest",
      type: "smoke|sanity|regression|e2e|integration|unit|api|ui|security|performance|accessibility",
      category: "happy_path|negative|edge|boundary|integration|workflow|security|accessibility",
      tags: ["traceability", "TM-001"],
      relatedAcceptanceCriteria: ["TM-001 or AC reference"],
      relatedBusinessRules: ["module/section/rule reference"],
      relatedModules: ["module-id"],
      preconditions: "Concrete setup required before execution",
      testData: "Realistic test data or empty string",
      steps: [
        {
          stepNumber: 1,
          action: "Preconditions:\n1. Required setup is available",
          expectedResult: "Preconditions are met",
        },
      ],
    },
  ],
  contextUsed: ["source IDs only, such as module-id, rule-id, or work-item-id"],
};
