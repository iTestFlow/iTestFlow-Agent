import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { truncationAuditDetails } from "@/modules/llm/llm-warnings";
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
  actor: string;
  provider: LLMProvider;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  projectKnowledgeNotice?: string | null;
  enabledChecklistItemIds?: RequirementAnalysisChecklistItemId[];
  extraInstructions?: string;
}) {
  const scope = assertProjectScope(input.scope);
  const promptDraft = buildRequirementAnalysisPromptDraft({
    scope,
    targetRequirement: input.targetRequirement,
    relatedWorkItems: input.relatedWorkItems ?? [],
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    projectKnowledgeNotice: input.projectKnowledgeNotice,
    enabledChecklistItemIds: input.enabledChecklistItemIds,
    extraInstructions: input.extraInstructions,
  });
  const result = await input.provider.generateStructuredOutput({
    schemaName: promptDraft.schemaName,
    schema: RequirementAnalysisOutputSchema,
    system: promptDraft.systemPrompt,
    user: promptDraft.userPrompt,
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
  const scopedOutput = normalizeRequirementAnalysisChecklistScope(result.validatedOutput, promptDraft.enabledChecklistItemIds);

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "requirement_analysis.run",
    status: "Success",
    message: "Requirement analysis completed with validated structured output.",
    details: {
      ...truncationAuditDetails(result.warnings),
      provider: result.provider,
      model: result.model,
      promptVersion: requirementAnalysisPrompt.version,
      enabledChecklistItemIds: promptDraft.enabledChecklistItemIds,
      droppedDisabledChecklistFindings: scopedOutput.droppedFindings,
    },
  });

  return {
    ...result,
    validatedOutput: scopedOutput.output,
    enabledChecklistItemIds: promptDraft.enabledChecklistItemIds,
    relevantProjectKnowledgeBase: promptDraft.relevantProjectKnowledgeBase,
    warnings: mergeWarnings(result.warnings, scopedOutput.warnings),
  };
}

export function buildRequirementAnalysisPromptDraft(input: {
  scope: ProjectScope;
  targetRequirement: unknown;
  relatedWorkItems?: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase?: unknown | null;
  projectKnowledgeNotice?: string | null;
  enabledChecklistItemIds?: RequirementAnalysisChecklistItemId[];
  extraInstructions?: string;
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
    projectKnowledgeNotice: input.projectKnowledgeNotice,
    extraInstructions: input.extraInstructions,
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
  actor: string;
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
  const scopedOutput = normalizeRequirementAnalysisChecklistScope(validatedOutput, enabledChecklistItemIds);

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "requirement_analysis.manual_complete",
    status: "Success",
    message: "Requirement analysis completed from validated external LLM output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: requirementAnalysisPrompt.version,
      targetWorkItemId: input.targetWorkItemId,
      enabledChecklistItemIds,
      droppedDisabledChecklistFindings: scopedOutput.droppedFindings,
    },
  });

  return {
    provider: "external",
    model: "manual-external",
    rawOutput: input.rawOutput,
    validatedOutput: scopedOutput.output,
    warnings: scopedOutput.warnings,
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

export function normalizeRequirementAnalysisChecklistScope(
  output: RequirementAnalysisOutput,
  enabledChecklistItemIds: RequirementAnalysisChecklistItemId[],
) {
  const enabledChecklistItemIdSet = new Set(enabledChecklistItemIds);
  const invalidFindings = output.findings.filter((finding) => !enabledChecklistItemIdSet.has(finding.checklistItemId));

  if (!invalidFindings.length) {
    return { output, warnings: undefined, droppedFindings: [] };
  }

  const scopedFindings = output.findings.filter((finding) => enabledChecklistItemIdSet.has(finding.checklistItemId));
  const invalidSummary = invalidFindings.map((finding) => `${finding.id} uses ${finding.checklistItemId}`).join(", ");
  const warning = `Ignored ${invalidFindings.length} requirement analysis finding${invalidFindings.length === 1 ? "" : "s"} for disabled checklist item${invalidFindings.length === 1 ? "" : "s"}: ${invalidSummary}.`;

  return {
    output: {
      ...output,
      findings: scopedFindings,
      summary: summarizeFindings(output.summary, scopedFindings),
    },
    warnings: [warning],
    droppedFindings: invalidFindings.map((finding) => ({
      id: finding.id,
      checklistItemId: finding.checklistItemId,
    })),
  };
}

function summarizeFindings(summary: RequirementAnalysisOutput["summary"], findings: RequirementAnalysisOutput["findings"]) {
  const counts = findings.reduce(
    (accumulator, finding) => {
      accumulator[finding.severity] += 1;
      return accumulator;
    },
    { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );

  return {
    ...summary,
    totalFindings: findings.length,
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    infoCount: counts.info,
  };
}

function mergeWarnings(...warningGroups: Array<string[] | undefined>) {
  const warnings = warningGroups.flatMap((group) => group ?? []).filter((warning) => warning.trim().length > 0);
  return warnings.length ? warnings : undefined;
}
