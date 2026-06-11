import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { truncationAuditDetails } from "@/modules/llm/llm-warnings";
import { parseExternalStructuredOutput } from "@/modules/llm/external-structured-output";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
import { buildTestCaseGenerationMarkdownPrompt, extractWorkItemId } from "@/modules/llm/markdown-prompt-renderer";
import { buildTestCaseGenerationSystemPrompt, testCaseGenerationPrompt } from "@/modules/llm/prompts";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { normalizeTestDesignOptions, type TestDesignOptions } from "@/modules/test-case-design/test-design-options";
import { TestCaseGenerationOutputSchema } from "../schemas/test-case.schema";

export async function generateTestCases(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  options?: Partial<TestDesignOptions>;
  extraInstructions?: string;
}) {
  const scope = assertProjectScope(input.scope);
  const promptDraft = buildTestCaseGenerationPromptDraft({
    scope,
    targetRequirement: input.targetRequirement,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    options: input.options,
    extraInstructions: input.extraInstructions,
  });
  const result = await input.provider.generateStructuredOutput({
    schemaName: promptDraft.schemaName,
    schema: TestCaseGenerationOutputSchema,
    system: promptDraft.systemPrompt,
    user: promptDraft.userPrompt,
    metadata: {
      action: "test_case_generation.run",
      promptName: testCaseGenerationPrompt.name,
      promptVersion: testCaseGenerationPrompt.version,
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
    action: "test_case_generation.run",
    status: "Success",
    message: `Generated ${result.validatedOutput.testCases.length} validated test cases.`,
    details: {
      ...truncationAuditDetails(result.warnings),
      provider: result.provider,
      model: result.model,
      promptVersion: testCaseGenerationPrompt.version,
      testDesignOptions: promptDraft.testDesignOptions,
    },
  });

  return {
    ...result,
    relevantProjectKnowledgeBase: promptDraft.relevantProjectKnowledgeBase,
  };
}

export function buildTestCaseGenerationPromptDraft(input: {
  scope: ProjectScope;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  options?: Partial<TestDesignOptions>;
  extraInstructions?: string;
}) {
  const scope = assertProjectScope(input.scope);
  const testDesignOptions = normalizeTestDesignOptions(input.options);
  const systemPrompt = buildTestCaseGenerationSystemPrompt(input.options);
  const promptPayload = buildTestCaseGenerationMarkdownPrompt({
    currentProject: {
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
    },
    targetRequirement: input.targetRequirement,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    options: testDesignOptions,
    extraInstructions: input.extraInstructions,
    outputContract: testCaseOutputContract,
  });

  return {
    schemaName: "TestCaseGenerationOutput",
    promptName: testCaseGenerationPrompt.name,
    promptVersion: testCaseGenerationPrompt.version,
    systemPrompt,
    userPrompt: promptPayload.prompt,
    prompt: buildManualPromptMarkdown({
      title: "iTestFlow Test Case Design",
      system: systemPrompt,
      user: promptPayload.prompt,
    }),
    testDesignOptions,
    relevantProjectKnowledgeBase: promptPayload.relevantProjectKnowledgeBase,
  };
}

export function completeManualTestCaseGeneration(input: {
  scope: ProjectScope;
  rawOutput: string;
  targetWorkItemId?: string;
}) {
  const scope = assertProjectScope(input.scope);
  const validatedOutput = parseExternalStructuredOutput({
    schemaName: "TestCaseGenerationOutput",
    schema: TestCaseGenerationOutputSchema,
    rawOutput: input.rawOutput,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "test_case_generation.manual_complete",
    status: "Success",
    message: `Generated ${validatedOutput.testCases.length} validated test cases from external LLM output.`,
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: testCaseGenerationPrompt.version,
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

const testCaseOutputContract = {
  testCases: [
    {
      id: "TC-MODULE-001",
      title: "Validate clear behavior",
      description: "Brief description of what the test validates",
      priority: "number only: 1|2|3|4, where 1 is highest and 4 is lowest",
      type: "execution type only: functional|smoke|sanity|regression|e2e|integration|unit|api|ui|security|performance|accessibility; never use a Coverage Focus value such as data-validation",
      category: "happy_path|negative|edge|boundary|integration|workflow|security|accessibility",
      tags: ["string"],
      relatedAcceptanceCriteria: ["AC reference"],
      relatedBusinessRules: ["module/section/rule reference"],
      relatedModules: ["module-id"],
      preconditions: "Detailed setup requirements",
      testData: "Realistic data, if applicable",
      steps: [
        {
          stepNumber: 1,
          action: "Preconditions:\n1. Required setup is available",
          expectedResult: "Preconditions are met",
        },
        {
          stepNumber: 2,
          action: "Specific tester action",
          expectedResult: "Specific measurable expected result",
        },
      ],
    },
  ],
  summary: {
    totalCases: 0,
    byType: { regression: 0 },
    byPriority: { "1": 0 },
    coverageEstimate: 0,
  },
  contextUsed: ["source IDs only, such as module-id or work-item-id"],
};
