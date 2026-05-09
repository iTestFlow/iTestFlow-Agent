import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { buildTaggedPromptPayload } from "@/modules/llm/prompt-payload";
import { testCaseGenerationPrompt } from "@/modules/llm/prompts";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { TestCaseGenerationOutputSchema } from "../schemas/test-case.schema";

export async function generateTestCases(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  options: Record<string, unknown>;
}) {
  const scope = assertProjectScope(input.scope);
  const userPrompt = buildTaggedPromptPayload([
    {
      tag: "current_project",
      value: {
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
      },
    },
    { tag: "work_item", value: input.targetRequirement },
    { tag: "related_work_items", value: input.relatedWorkItems ?? [] },
    {
      tag: "project_context",
      value: {
        selectedContext: input.selectedContext,
        projectKnowledgeBase: input.projectKnowledgeBase ?? null,
        options: input.options,
      },
    },
    { tag: "output_contract", value: testCaseOutputContract },
  ]);
  const result = await input.provider.generateStructuredOutput({
    schemaName: "TestCaseGenerationOutput",
    schema: TestCaseGenerationOutputSchema,
    system: testCaseGenerationPrompt.system,
    user: userPrompt,
    metadata: {
      action: "test_case_generation.run",
      promptName: testCaseGenerationPrompt.name,
      promptVersion: testCaseGenerationPrompt.version,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      targetWorkItemId: targetRequirementId(input.targetRequirement),
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
      provider: result.provider,
      model: result.model,
      promptVersion: testCaseGenerationPrompt.version,
    },
  });

  return result;
}

const testCaseOutputContract = {
  testCases: [
    {
      id: "TC-MODULE-001",
      title: "Validate clear behavior",
      description: "Brief description of what the test validates",
      priority: "critical|high|medium|low",
      type: "smoke|sanity|regression|e2e|integration|unit|api|ui|security|performance|accessibility",
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
    byPriority: { high: 0 },
    coverageEstimate: 0,
  },
  contextUsed: ["module-id or work-item-id"],
};

function targetRequirementId(value: unknown) {
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  }
  return undefined;
}
