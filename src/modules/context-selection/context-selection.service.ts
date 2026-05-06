import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { contextSelectionPrompt } from "@/modules/llm/prompts";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { ContextSuggestionOutputSchema } from "./context-selection.schema";

export async function suggestContextStories(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: unknown;
  retrievedContext: unknown[];
}) {
  const scope = assertProjectScope(input.scope);
  const result = await input.provider.generateStructuredOutput({
    schemaName: "ContextSuggestionOutput",
    schema: ContextSuggestionOutputSchema,
    system: contextSelectionPrompt.system,
    user: JSON.stringify({
      targetRequirement: input.targetRequirement,
      retrievedContext: input.retrievedContext,
      projectScope: {
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
      },
    }),
    maxTokens: 8192,
    repairOnInvalidOutput: false,
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "context_selection.suggest",
    status: "Success",
    message: `Suggested ${result.validatedOutput.suggestedItems.length} context stories.`,
    details: { provider: result.provider, model: result.model, promptVersion: contextSelectionPrompt.version },
  });

  return result;
}
