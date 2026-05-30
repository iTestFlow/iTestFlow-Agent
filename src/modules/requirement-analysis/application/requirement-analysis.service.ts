import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { parseExternalStructuredOutput } from "@/modules/llm/external-structured-output";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
import { buildRequirementAnalysisMarkdownPrompt, extractWorkItemId } from "@/modules/llm/markdown-prompt-renderer";
import {
  buildRequirementAnalysisSystemPrompt,
  normalizeRequirementAnalysisChecklistItemIds,
  requirementAnalysisPrompt,
} from "@/modules/llm/prompts";
import type { RequirementAnalysisChecklistItemId } from "@/modules/requirement-analysis/checklist-options";
import { RequirementAnalysisOutputSchema, type RequirementAnalysisOutput } from "../schemas/requirement-analysis.schema";

export async function runRequirementAnalysis(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  enabledChecklistItemIds?: RequirementAnalysisChecklistItemId[];
}) {
  const scope = assertProjectScope(input.scope);
  const promptDraft = buildRequirementAnalysisPromptDraft({
    scope,
    targetRequirement: input.targetRequirement,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    enabledChecklistItemIds: input.enabledChecklistItemIds,
  });
  const result = await input.provider.generateStructuredOutput({
    schemaName: promptDraft.schemaName,
    schema: RequirementAnalysisOutputSchema,
    system: promptDraft.systemPrompt,
    user: promptDraft.userPrompt,
    maxTokens: 12000,
    metadata: {
      action: "requirement_analysis.run",
      promptName: requirementAnalysisPrompt.name,
      promptVersion: requirementAnalysisPrompt.version,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      targetWorkItemId: extractWorkItemId(input.targetRequirement),
    },
  });
  assertRequirementAnalysisChecklistScope(result.validatedOutput, promptDraft.enabledChecklistItemIds);

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
      enabledChecklistItemIds: promptDraft.enabledChecklistItemIds,
    },
  });

  return { ...result, enabledChecklistItemIds: promptDraft.enabledChecklistItemIds };
}

export function buildRequirementAnalysisPromptDraft(input: {
  scope: ProjectScope;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  enabledChecklistItemIds?: RequirementAnalysisChecklistItemId[];
}) {
  const scope = assertProjectScope(input.scope);
  const enabledChecklistItemIds = normalizeRequirementAnalysisChecklistItemIds(input.enabledChecklistItemIds);
  const systemPrompt = buildRequirementAnalysisSystemPrompt(enabledChecklistItemIds);
  const promptPayload = buildRequirementAnalysisMarkdownPrompt({
    currentProject: {
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
    },
    targetRequirement: input.targetRequirement,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    outputContract: buildRequirementOutputContract(enabledChecklistItemIds),
  });

  return {
    schemaName: "RequirementAnalysisOutput",
    promptName: requirementAnalysisPrompt.name,
    promptVersion: requirementAnalysisPrompt.version,
    enabledChecklistItemIds,
    systemPrompt,
    userPrompt: promptPayload.prompt,
    prompt: buildManualPromptMarkdown({
      title: "iTestFlow Requirement Analysis",
      system: systemPrompt,
      user: promptPayload.prompt,
    }),
    relevantProjectKnowledgeBase: promptPayload.relevantProjectKnowledgeBase,
  };
}

export function completeManualRequirementAnalysis(input: {
  scope: ProjectScope;
  rawOutput: string;
  targetWorkItemId?: string;
  enabledChecklistItemIds: RequirementAnalysisChecklistItemId[];
}) {
  const scope = assertProjectScope(input.scope);
  const enabledChecklistItemIds = normalizeRequirementAnalysisChecklistItemIds(input.enabledChecklistItemIds);
  const validatedOutput = parseExternalStructuredOutput({
    schemaName: "RequirementAnalysisOutput",
    schema: RequirementAnalysisOutputSchema,
    rawOutput: input.rawOutput,
  });
  assertRequirementAnalysisChecklistScope(validatedOutput, enabledChecklistItemIds);

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "requirement_analysis.manual_complete",
    status: "Success",
    message: "Requirement analysis completed from validated external LLM output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: requirementAnalysisPrompt.version,
      targetWorkItemId: input.targetWorkItemId,
      enabledChecklistItemIds,
    },
  });

  return {
    provider: "external",
    model: "manual-external",
    rawOutput: input.rawOutput,
    validatedOutput,
  };
}

function buildRequirementOutputContract(enabledChecklistItemIds: RequirementAnalysisChecklistItemId[]) {
  return {
    findings: [
      {
        id: "F-001",
        checklistItemId: enabledChecklistItemIds.join("|"),
        issueType:
          "ambiguity|conflict|missing_requirement|incomplete_criteria|inconsistency|non_testable_requirement|unsupported_assumption|unhandled_edge_case|ownership_gap|traceability_gap|risk_gap",
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
    contextUsed: ["source IDs only, such as module-id or work-item-id"],
  };
}

function assertRequirementAnalysisChecklistScope(output: RequirementAnalysisOutput, enabledChecklistItemIds: RequirementAnalysisChecklistItemId[]) {
  const enabledChecklistItemIdSet = new Set(enabledChecklistItemIds);
  const invalidFindings = output.findings.filter((finding) => !enabledChecklistItemIdSet.has(finding.checklistItemId));

  if (!invalidFindings.length) return;

  const invalidSummary = invalidFindings.map((finding) => `${finding.id} uses ${finding.checklistItemId}`).join(", ");
  throw new Error(
    `Requirement analysis output included findings for disabled checklist items: ${invalidSummary}. Enabled checklist items: ${enabledChecklistItemIds.join(", ")}.`,
  );
}
