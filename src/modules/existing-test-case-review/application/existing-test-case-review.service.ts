import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { existingTestCaseReviewPrompt } from "@/modules/llm/prompts";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { ExistingTestCaseReviewOutputSchema } from "../schemas/existing-test-case-review.schema";

export async function reviewExistingLinkedTestCases(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: unknown;
  linkedTestCases: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
}) {
  const scope = assertProjectScope(input.scope);
  const result = await input.provider.generateStructuredOutput({
    schemaName: "ExistingTestCaseReviewOutput",
    schema: ExistingTestCaseReviewOutputSchema,
    system: existingTestCaseReviewPrompt.system,
    user: JSON.stringify({
      targetRequirement: input.targetRequirement,
      linkedTestCases: input.linkedTestCases,
      selectedContext: input.selectedContext,
      projectKnowledgeBase: input.projectKnowledgeBase ?? null,
      projectScope: {
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
      },
    }),
    metadata: {
      action: "existing_test_case_review.run",
      promptName: existingTestCaseReviewPrompt.name,
      promptVersion: existingTestCaseReviewPrompt.version,
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
    action: "existing_test_case_review.run",
    status: "Success",
    message: `Reviewed ${input.linkedTestCases.length} linked Azure DevOps test cases.`,
    details: {
      provider: result.provider,
      model: result.model,
      promptVersion: existingTestCaseReviewPrompt.version,
    },
  });

  return result;
}

function targetRequirementId(value: unknown) {
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  }
  return undefined;
}
