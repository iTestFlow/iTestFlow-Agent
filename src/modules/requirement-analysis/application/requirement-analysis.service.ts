import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { RequirementAnalysisOutputSchema } from "../schemas/requirement-analysis.schema";
import { requirementAnalysisPrompt } from "../prompts/requirement-analysis.prompt";

export async function runRequirementAnalysis(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: unknown;
  selectedContext: unknown[];
}) {
  const scope = assertProjectScope(input.scope);
  const result = await input.provider.generateStructuredOutput({
    schemaName: "RequirementAnalysisOutput",
    schema: RequirementAnalysisOutputSchema,
    system: requirementAnalysisPrompt.system,
    user: JSON.stringify({
      targetRequirement: input.targetRequirement,
      selectedContext: input.selectedContext,
      projectScope: {
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
      },
    }),
    maxTokens: 12000,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "requirement_analysis.run",
    status: "Success",
    message: "Requirement analysis completed with validated structured output.",
    details: {
      provider: result.provider,
      model: result.model,
      promptVersion: requirementAnalysisPrompt.version,
    },
  });

  return result;
}
