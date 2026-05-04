import "server-only";

import { writeAuditLog } from "@/modules/audit/audit.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
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
    system: [
      "You select the most relevant Azure DevOps context work items for QA requirement analysis.",
      "Use only retrievedContext items from the selected project; never invent IDs, titles, relationships, systems, rules, or risks.",
      "Return only compact valid JSON with this exact root shape: {\"suggestedItems\":[{\"workItemId\":\"string\",\"title\":\"string\",\"workItemType\":\"string\",\"relationshipType\":\"optional string\",\"relevanceScore\":0.8,\"reason\":\"string\"}]}",
      "Include up to 8 items sorted by relevanceScore descending. Use relevanceScore between 0 and 1.",
      "Each reason must be one concise sentence explaining why that work item helps QA analyze the target requirement.",
      "If no retrievedContext item is relevant, return {\"suggestedItems\":[]}.",
    ].join("\n"),
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
    details: { provider: result.provider, model: result.model },
  });

  return result;
}
