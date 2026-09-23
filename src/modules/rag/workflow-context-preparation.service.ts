import "server-only";

import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import type { ProviderId } from "@/modules/integrations/core/provider-types";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { estimateTokens, usableInputTokens } from "@/modules/llm/token-estimate";
import type { StoryAttachmentPromptContext } from "@/modules/llm/markdown-prompt-renderer";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  buildExistingTestCaseReviewPromptDraft,
} from "@/modules/existing-test-case-review/application/existing-test-case-review.service";
import {
  buildRequirementAnalysisPromptDraft,
} from "@/modules/requirement-analysis/application/requirement-analysis.service";
import type { RequirementAnalysisChecklistItemId } from "@/modules/requirement-analysis/checklist-options";
import {
  resolveWorkflowContext,
  resolveWorkflowContextWithoutLLM,
  ReviewedContextSourceUnavailableError,
  type ContextUsedItem,
} from "@/modules/rag/auto-context-resolver.service";
import {
  filterProjectKnowledgeForContextControls,
  filterWorkItemSourcesForContextControls,
  isWorkflowContextSourceAllowed,
  normalizeWorkflowContextControls,
  sourceIdForStoryAttachment,
  type WorkflowContextControls,
} from "@/modules/rag/workflow-context-controls";
import {
  buildWorkflowContextCitations,
  type WorkflowContextCitation,
} from "@/modules/rag/workflow-context-citations";
import { rankProjectKnowledgeForWorkItem } from "@/modules/rag/knowledge-relevance.service";
import { loadProjectKnowledgeContext } from "@/modules/rag/project-knowledge.service";
import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import { resolveRetrievalTopK } from "@/modules/rag/retrieval-config";
import {
  loadSelectedStoryAttachmentWorkflowContext,
  type StoryAttachmentWorkflowContext,
} from "@/modules/story-attachments/story-attachment-workflow-context";
import {
  buildTestCaseGenerationPromptDraft,
} from "@/modules/test-case-design/application/test-case-generation.service";
import type { TestDesignOptions } from "@/modules/test-case-design/test-design-options";
import {
  StoryAttachmentNotReadyError,
  StoryAttachmentValidationError,
} from "@/modules/story-attachments/story-attachments.service";

export const workflowContextWorkflowValues = [
  "requirement_analysis",
  "test_case_generation",
  "existing_test_case_review",
] as const;

export type WorkflowContextWorkflow = (typeof workflowContextWorkflowValues)[number];
export type WorkflowContextMode = "auto" | "manual";

type WorkflowPromptDraft = {
  prompt: string;
  userPrompt: string;
  relevantProjectKnowledgeBase: ProjectKnowledgeBase | null;
  includedStoryAttachmentTextIds?: string[];
  omittedStoryAttachmentTextIds?: string[];
  storyAttachmentWarnings?: string[];
  [key: string]: unknown;
};

export type PreparedWorkflowContext = {
  workflow: WorkflowContextWorkflow;
  mode: WorkflowContextMode;
  targetRequirement: Requirement;
  linkedTestCases: unknown[];
  relatedWorkItems: unknown[];
  selectedContext: unknown[];
  contextUsed: ContextUsedItem[];
  projectKnowledgeBase: ProjectKnowledgeBase | null | undefined;
  projectKnowledgeNotice: string | null;
  rankedKnowledgeKeys: Record<string, string[]> | undefined;
  storyAttachmentContext?: StoryAttachmentWorkflowContext;
  maxInputTokens: number | undefined;
  retrievalTopK: number;
  promptDraft: WorkflowPromptDraft;
  contextCitations: WorkflowContextCitation[];
  /** The controls supplied by the caller, retained for the post-render check. */
  controls: WorkflowContextControls;
  /** Knowledge source IDs hidden because one of their evidence stories was removed. */
  implicitlyExcludedSourceIds: string[];
  /** Exact references available to freeze after a preview. */
  reviewedSourceIds: string[];
  excludedSourceIds: string[];
  contextConsistency: {
    valid: true;
    missingSourceIds: [];
  };
};

export class ContextReviewRequiredError extends Error {
  readonly code = "CONTEXT_REVIEW_REQUIRED";

  constructor(
    readonly missingSourceIds: string[],
    message = "Context changed after review. Refresh the context review before continuing.",
  ) {
    super(message);
    this.name = "ContextReviewRequiredError";
  }
}

export function isContextReviewRequiredError(error: unknown): error is ContextReviewRequiredError {
  return error instanceof ContextReviewRequiredError;
}

/**
 * Resolve and render the exact optional inputs that a workflow will use.  Preview
 * calls use deterministic retrieval only; a reviewed automatic request also avoids
 * a second selector pass so it can never refill the user-approved set.
 */
export async function prepareWorkflowContext(input: {
  workflow: WorkflowContextWorkflow;
  mode: WorkflowContextMode;
  preview?: boolean;
  scope: ProjectScope;
  actor?: string;
  adapter: AzureDevOpsAdapter;
  provider?: LLMProvider;
  workspaceId: string;
  workspaceProviderId: ProviderId;
  targetRequirement: Requirement;
  selectedContextIds?: string[];
  attachmentIds?: string[];
  reviewedSourceIds?: string[];
  excludedSourceIds?: string[];
  maxInputTokens?: number;
  enabledChecklistItemIds?: RequirementAnalysisChecklistItemId[];
  options?: Partial<TestDesignOptions>;
  extraInstructions?: string;
}): Promise<PreparedWorkflowContext> {
  const controls = normalizeWorkflowContextControls({
    reviewedSourceIds: input.reviewedSourceIds,
    excludedSourceIds: input.excludedSourceIds,
  });
  const retrievalTopK = await resolveRetrievalTopK({
    workspaceId: input.workspaceId,
    query: `${input.targetRequirement.title}\n${input.targetRequirement.description ?? ""}`,
  });
  const resolutionInput = {
    scope: input.scope,
    adapter: input.adapter,
    targetRequirement: input.targetRequirement,
    selectedContextIds: input.selectedContextIds ?? [],
    retrievalTopK,
    reviewedSourceIds: controls.reviewedSourceIds,
    excludedSourceIds: controls.excludedSourceIds,
  };
  const canSelectWithLlm = input.mode === "auto" && !input.preview && controls.reviewedSourceIds === undefined;
  let autoContext;
  try {
    autoContext = canSelectWithLlm
      ? await resolveWorkflowContext({
          ...resolutionInput,
          actor: requiredActor(input.actor),
          provider: requiredProvider(input.provider),
          workflowType: input.workflow,
        })
      : await resolveWorkflowContextWithoutLLM(resolutionInput);
  } catch (error) {
    if (error instanceof ReviewedContextSourceUnavailableError) {
      throw new ContextReviewRequiredError([error.sourceId]);
    }
    throw error;
  }
  const relatedWorkItems = filterWorkItemSourcesForContextControls(autoContext.relatedWorkItems, controls);
  const selectedContext = filterWorkItemSourcesForContextControls(autoContext.selectedContext, controls);
  const contextUsed = filterWorkItemSourcesForContextControls(autoContext.contextUsed, controls);
  const knowledgeContext = await loadProjectKnowledgeContext({
    scope: input.scope,
    consumer: knowledgeConsumer(input.workflow, input.mode),
  });
  const implicitlyExcludedSourceIds = knowledgeSourceIdsDerivedFromExcludedWorkItems(
    knowledgeContext.knowledgeBase,
    controls.excludedSourceIds,
  );
  const projectKnowledgeBase = filterProjectKnowledgeForContextControls(knowledgeContext.knowledgeBase, controls);
  const rankedKnowledgeKeys = await rankProjectKnowledgeForWorkItem({
    scope: input.scope,
    targetRequirement: input.targetRequirement,
    projectKnowledgeBase,
    contextWorkItemIds: [
      ...relatedWorkItems.map((item) => item.workItemId),
      ...selectedContext.map((item) => item.workItemId),
    ],
  });
  const storyAttachmentContext = await prepareStoryAttachmentContext({
    input,
    controls,
  });
  const linkedTestCases = input.workflow === "existing_test_case_review"
    ? await input.adapter.fetchLinkedTestCases({
        projectId: input.scope.azureProjectId,
        userStoryId: input.targetRequirement.id,
      })
    : [];
  const promptDraft = buildWorkflowPromptDraft({
    input,
    linkedTestCases,
    relatedWorkItems,
    selectedContext,
    projectKnowledgeBase,
    projectKnowledgeNotice: knowledgeContext.promptNotice,
    rankedKnowledgeKeys: rankedKnowledgeKeys ?? undefined,
    storyAttachments: storyAttachmentContext?.promptAttachments,
    maxInputTokens: storyAttachmentContext?.effectivePromptInputTokens ?? input.maxInputTokens,
    retrievalTopK: autoContext.retrievalTopK,
  });
  const contextCitations = buildContextCitations({
    contextUsed,
    promptDraft,
    storyAttachmentContext,
  });
  assertReviewedContextConsistency(controls, contextCitations, implicitlyExcludedSourceIds);
  assertReviewedPromptFitsBudget(controls, promptDraft, input.mode,
    storyAttachmentContext?.effectivePromptInputTokens ?? input.maxInputTokens,
    implicitlyExcludedSourceIds);

  return {
    workflow: input.workflow,
    mode: input.mode,
    targetRequirement: input.targetRequirement,
    linkedTestCases,
    relatedWorkItems,
    selectedContext,
    contextUsed,
    projectKnowledgeBase,
    projectKnowledgeNotice: knowledgeContext.promptNotice,
    rankedKnowledgeKeys: rankedKnowledgeKeys ?? undefined,
    storyAttachmentContext,
    maxInputTokens: storyAttachmentContext?.effectivePromptInputTokens ?? input.maxInputTokens,
    retrievalTopK: autoContext.retrievalTopK,
    promptDraft,
    contextCitations,
    controls,
    implicitlyExcludedSourceIds,
    reviewedSourceIds: contextCitations.map((citation) => citation.sourceId),
    excludedSourceIds: controls.excludedSourceIds,
    contextConsistency: { valid: true, missingSourceIds: [] },
  };
}

/** Build citations from a workflow's final renderer output, then recheck a reviewed set. */
export function buildPreparedWorkflowContextCitations(
  preparation: PreparedWorkflowContext,
  result: {
    relevantProjectKnowledgeBase?: ProjectKnowledgeBase | null;
    includedStoryAttachmentTextIds?: string[];
  },
) {
  const citations = buildContextCitations({
    contextUsed: preparation.contextUsed,
    promptDraft: {
      ...preparation.promptDraft,
      relevantProjectKnowledgeBase: result.relevantProjectKnowledgeBase ?? null,
      includedStoryAttachmentTextIds: result.includedStoryAttachmentTextIds,
    },
    storyAttachmentContext: preparation.storyAttachmentContext,
  });
  assertReviewedContextConsistency({
    reviewedSourceIds: preparation.controls.reviewedSourceIds,
    excludedSourceIds: preparation.controls.excludedSourceIds,
  }, citations, preparation.implicitlyExcludedSourceIds);
  return citations;
}

function buildWorkflowPromptDraft(input: {
  input: Parameters<typeof prepareWorkflowContext>[0];
  linkedTestCases: unknown[];
  relatedWorkItems: unknown[];
  selectedContext: unknown[];
  projectKnowledgeBase: ProjectKnowledgeBase | null | undefined;
  projectKnowledgeNotice: string | null;
  rankedKnowledgeKeys: Record<string, string[]> | undefined;
  storyAttachments: StoryAttachmentPromptContext[] | undefined;
  maxInputTokens: number | undefined;
  retrievalTopK: number;
}): WorkflowPromptDraft {
  const shared = {
    scope: input.input.scope,
    targetRequirement: input.input.targetRequirement,
    relatedWorkItems: input.relatedWorkItems,
    selectedContext: input.selectedContext,
    projectKnowledgeBase: input.projectKnowledgeBase,
    maxInputTokens: input.maxInputTokens,
    relatedWorkItemsFloor: input.retrievalTopK,
    rankedKnowledgeKeys: input.rankedKnowledgeKeys,
    projectKnowledgeNotice: input.projectKnowledgeNotice,
    extraInstructions: input.input.extraInstructions,
  };
  const draftInput = shared;

  switch (input.input.workflow) {
    case "requirement_analysis":
      return buildRequirementAnalysisPromptDraft({
        ...draftInput,
        storyAttachments: input.storyAttachments,
        enabledChecklistItemIds: input.input.enabledChecklistItemIds,
      });
    case "test_case_generation":
      return buildTestCaseGenerationPromptDraft({
        ...draftInput,
        storyAttachments: input.storyAttachments,
        options: input.input.options,
      });
    case "existing_test_case_review":
      return buildExistingTestCaseReviewPromptDraft({
        ...draftInput,
        linkedTestCases: input.linkedTestCases,
      });
  }
}

async function prepareStoryAttachmentContext(input: {
  input: Parameters<typeof prepareWorkflowContext>[0];
  controls: WorkflowContextControls;
}) {
  if (input.input.workflow === "existing_test_case_review") return undefined;
  const attachmentIds = (input.input.attachmentIds ?? []).filter((attachmentId) =>
    isWorkflowContextSourceAllowed(sourceIdForStoryAttachment(attachmentId), input.controls),
  );
  try {
    return await loadSelectedStoryAttachmentWorkflowContext({
      scope: {
        workspaceId: input.input.workspaceId,
        projectId: input.input.scope.projectId,
        providerId: input.input.workspaceProviderId,
        canonicalStoryId: canonicalStoryId(input.input.targetRequirement),
        storyDisplayKey: input.input.targetRequirement.id.trim(),
      },
      attachmentIds,
      includeVisuals: input.input.mode === "auto",
      maxInputTokens: input.input.maxInputTokens,
    });
  } catch (error) {
    if (input.controls.reviewedSourceIds !== undefined &&
      (error instanceof StoryAttachmentValidationError || error instanceof StoryAttachmentNotReadyError)) {
      throw new ContextReviewRequiredError(attachmentIds.map(sourceIdForStoryAttachment));
    }
    throw error;
  }
}

function buildContextCitations(input: {
  contextUsed: ContextUsedItem[];
  promptDraft: Pick<WorkflowPromptDraft, "relevantProjectKnowledgeBase" | "includedStoryAttachmentTextIds">;
  storyAttachmentContext?: StoryAttachmentWorkflowContext;
}) {
  const includedAttachmentTextIds = new Set(input.promptDraft.includedStoryAttachmentTextIds ?? []);
  return buildWorkflowContextCitations({
    resolvedContextUsed: input.contextUsed,
    relevantProjectKnowledgeBase: input.promptDraft.relevantProjectKnowledgeBase,
    storyAttachments: input.storyAttachmentContext?.citationAttachments.filter((attachment) => (
      includedAttachmentTextIds.has(attachment.id.trim()) || attachment.visualCount > 0
    )),
  });
}

function assertReviewedContextConsistency(
  controlsInput: Pick<WorkflowContextControls, "reviewedSourceIds" | "excludedSourceIds">,
  citations: WorkflowContextCitation[],
  implicitlyExcludedSourceIds: readonly string[] = [],
) {
  const controls = normalizeWorkflowContextControls(controlsInput);
  if (controls.reviewedSourceIds === undefined) return;
  const actualSourceIds = new Set(citations.map((citation) => citation.sourceId));
  const intentionallyAbsentSourceIds = new Set([
    ...controls.excludedSourceIds,
    ...implicitlyExcludedSourceIds,
  ]);
  const missingSourceIds = controls.reviewedSourceIds.filter((sourceId) => (
    !intentionallyAbsentSourceIds.has(sourceId) && !actualSourceIds.has(sourceId)
  ));
  if (missingSourceIds.length) throw new ContextReviewRequiredError(missingSourceIds);
}

function assertReviewedPromptFitsBudget(
  controls: WorkflowContextControls,
  promptDraft: WorkflowPromptDraft,
  mode: WorkflowContextMode,
  maxInputTokens: number | undefined,
  implicitlyExcludedSourceIds: readonly string[],
) {
  if (controls.reviewedSourceIds === undefined) return;
  const retainedSourceIds = controls.reviewedSourceIds.filter((sourceId) =>
    !controls.excludedSourceIds.includes(sourceId) && !implicitlyExcludedSourceIds.includes(sourceId),
  );
  if (!retainedSourceIds.length) return;
  const systemPrompt = typeof promptDraft.systemPrompt === "string" ? promptDraft.systemPrompt : "";
  const fullPrompt = mode === "manual" ? promptDraft.prompt : `${systemPrompt}\n${promptDraft.userPrompt}`;
  if (estimateTokens(fullPrompt) > usableInputTokens(maxInputTokens)) {
    throw new ContextReviewRequiredError(
      retainedSourceIds,
      "The reviewed context no longer fits the prompt. Refresh the review and remove some references.",
    );
  }
}

function knowledgeSourceIdsDerivedFromExcludedWorkItems(
  knowledgeBase: ProjectKnowledgeBase | null | undefined,
  excludedSourceIds: readonly string[],
) {
  if (!knowledgeBase || !excludedSourceIds.length) return [];
  const excludedWorkItemIds = new Set(
    excludedSourceIds
      .filter((sourceId) => sourceId.startsWith("WI:"))
      .map((sourceId) => sourceId.slice("WI:".length).trim())
      .filter(Boolean),
  );
  if (!excludedWorkItemIds.size) return [];
  return buildWorkflowContextCitations({
    resolvedContextUsed: [],
    relevantProjectKnowledgeBase: knowledgeBase,
  })
    .filter((citation) => citation.sourceType === "project_knowledge")
    .filter((citation) => citation.sourceWorkItemIds.some((workItemId) => excludedWorkItemIds.has(workItemId)))
    .map((citation) => citation.sourceId);
}

function canonicalStoryId(targetRequirement: Requirement) {
  const raw = targetRequirement.raw;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const id = (raw as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
    if (typeof id === "number" && Number.isFinite(id)) return String(id);
  }
  return targetRequirement.id.trim();
}

function requiredProvider(provider: LLMProvider | undefined) {
  if (!provider) throw new Error("An LLM provider is required for automatic context selection.");
  return provider;
}

function requiredActor(actor: string | undefined) {
  if (!actor) throw new Error("An audit actor is required for automatic context selection.");
  return actor;
}

function knowledgeConsumer(workflow: WorkflowContextWorkflow, mode: WorkflowContextMode) {
  const suffix = mode === "manual" ? "_manual" : "";
  switch (workflow) {
    case "requirement_analysis":
      return `requirement_analysis${suffix}`;
    case "test_case_generation":
      return `test_case_design${suffix}`;
    case "existing_test_case_review":
      return `existing_test_case_review${suffix}`;
  }
}
