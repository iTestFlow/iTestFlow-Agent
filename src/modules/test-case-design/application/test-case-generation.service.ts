import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { testCaseGenerationPrompt } from "../prompts/test-case-generation.prompt";
import { TestCaseGenerationOutputSchema } from "../schemas/test-case.schema";

export async function generateTestCases(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: unknown;
  selectedContext: unknown[];
  options: Record<string, unknown>;
}) {
  const scope = assertProjectScope(input.scope);
  const result = await input.provider.generateStructuredOutput({
    schemaName: "TestCaseGenerationOutput",
    schema: TestCaseGenerationOutputSchema,
    system: testCaseGenerationPrompt.system,
    user: JSON.stringify({
      targetRequirement: input.targetRequirement,
      selectedContext: input.selectedContext,
      options: input.options,
      projectScope: {
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
      },
    }),
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
