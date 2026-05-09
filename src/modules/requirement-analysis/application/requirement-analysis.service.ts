import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { buildTaggedPromptPayload } from "@/modules/llm/prompt-payload";
import { requirementAnalysisPrompt } from "@/modules/llm/prompts";
import { RequirementAnalysisOutputSchema } from "../schemas/requirement-analysis.schema";

export async function runRequirementAnalysis(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
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
      },
    },
    { tag: "output_contract", value: requirementOutputContract },
  ]);
  const result = await input.provider.generateStructuredOutput({
    schemaName: "RequirementAnalysisOutput",
    schema: RequirementAnalysisOutputSchema,
    system: requirementAnalysisPrompt.system,
    user: userPrompt,
    maxTokens: 12000,
    metadata: {
      action: "requirement_analysis.run",
      promptName: requirementAnalysisPrompt.name,
      promptVersion: requirementAnalysisPrompt.version,
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

const requirementOutputContract = {
  findings: [
    {
      id: "F-001",
      type: "ambiguity|conflict|missing_requirement|incomplete_criteria|inconsistency|security_concern|performance_concern|ux_issue|dependency_issue|business_rule_violation",
      severity: "critical|high|medium|low|info",
      title: "Brief finding title",
      description: "Detailed grounded description",
      suggestion: "Specific recommended resolution",
      riskLevel: "high|medium|low",
      riskJustification: "Business-impact justification for risk",
      affectedAreas: ["module/page/component/api/workflow"],
      references: [{ module: "module-id", section: "section name", sourceId: "work item or rule id", description: "source detail" }],
      contradiction: false,
    },
  ],
  summary: {
    totalFindings: 0,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    infoCount: 0,
    overallQuality: "poor|fair|good|excellent",
    completenessScore: 0,
    clarityScore: 0,
    testabilityScore: 0,
    summaryText: "Concise summary; acknowledge if the story is well-written.",
  },
  recommendations: ["string"],
  questionsForProductOwner: ["string"],
  contextUsed: ["module-id or work-item-id"],
};

function targetRequirementId(value: unknown) {
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  }
  return undefined;
}
