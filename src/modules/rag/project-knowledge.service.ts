import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { parseExternalStructuredOutput } from "@/modules/llm/external-structured-output";
import type { LLMProvider, LLMResult } from "@/modules/llm/llm-types";
import { addTokenUsage, hasTokenUsage } from "@/modules/llm/token-usage";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
import {
  projectKnowledgeConsolidationPrompt,
  projectKnowledgeExtractionPrompt,
} from "@/modules/llm/prompts";
import { nowIso, sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import {
  PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
  ProjectKnowledgeBaseSchema,
  type ProjectKnowledgeBase,
} from "./project-knowledge.schema";
import {
  mergeProjectKnowledgeConflictEntries,
  type ProjectKnowledgeConsolidationCategory,
  type ProjectKnowledgeEntryByConsolidationCategory,
} from "./project-knowledge-consolidation";
import { canonicalizeProjectKnowledgeLogicalIdentity } from "./project-knowledge-contracts";
import {
  recordProjectKnowledgeLog,
  type ProjectKnowledgeCompilationMode,
} from "./project-knowledge-compiled.service";
import { ensureProjectContextSyncSchema } from "./project-context-schema.service";
import { backfillProjectKnowledgeCompilerFoundation } from "./project-knowledge-migration.service";
import {
  beginProjectKnowledgeDraft,
  completeProjectKnowledgeDraft,
  failProjectKnowledgeDraft,
  getProjectKnowledgeDraft,
  heartbeatProjectKnowledgeDraft,
  loadCurrentProjectKnowledgeSourceManifest,
  loadProjectKnowledgeManualBatchResults,
  publishProjectKnowledgeDraft,
  setProjectKnowledgeDraftCompilationMode,
  storeProjectKnowledgeManualDraftBatches,
  saveProjectKnowledgeManualBatchResult,
  tryDeterministicProjectKnowledgeRebase,
  type ProjectKnowledgeDraft,
} from "./project-knowledge-draft.service";

// Keep each extraction batch's INPUT small enough that its structured OUTPUT comfortably
// fits under the output-token cap. Smaller batches are cheap now that consolidation is a
// local deterministic merge (no per-build LLM call), so we favour staying well under the cap.
const MAX_CONTEXT_INPUT_CHARS = 18000;
// How many extraction batches to run at once. Bounded so large projects don't burst the
// provider's rate limit; deterministic consolidation merges the results regardless of order.
const KNOWLEDGE_BATCH_CONCURRENCY = 3;
type ProjectKnowledgeCompileMode = Extract<ProjectKnowledgeCompilationMode, "incremental" | "full">;
type ProjectKnowledgeSourceHashMap = Record<string, string | null>;

type ProjectKnowledgeSnapshotWorkItemRow = {
  id: string;
  azure_work_item_id: string;
  work_item_type: string;
  content_hash: string;
  fields_json: unknown;
  source_updated_at: string | null;
};

type ProjectKnowledgeWorkItem = {
  id: string;
  workItemType: string;
  title: string;
  state?: string;
  description?: string;
  acceptanceCriteria?: string;
  tags?: string[];
  areaPath?: string;
  iterationPath?: string;
  updatedDate?: string;
  contentHash?: string | null;
  sourceSnapshotId: string;
};

type ProjectKnowledgeSnapshotRow = {
  id: string;
  prompt_version: string;
  provider: string | null;
  model_name: string | null;
  source_work_item_count: number;
  raw_output: string | null;
  validated_output: string;
  status: string;
  error_details: string | null;
  extracted_at: string;
  created_at: string;
  updated_at: string;
  active_revision_id: string | null;
  source_fingerprint: string | null;
  semantic_hash: string | null;
  provenance_hash: string | null;
  compiler_contract_version: string;
  freshness_status: string;
  provenance_status: string;
  compiler_compatibility: string;
  stale_since: string | null;
  stale_reason_json: unknown;
};

export type ProjectKnowledgeSnapshot = {
  id: string;
  promptVersion: string;
  provider?: string | null;
  model?: string | null;
  sourceWorkItemCount: number;
  rawOutput?: string | null;
  knowledgeBase: ProjectKnowledgeBase;
  status: string;
  errorDetails?: string | null;
  extractedAt: string;
  createdAt: string;
  updatedAt: string;
  activeRevisionId: string | null;
  sourceFingerprint: string | null;
  semanticHash: string | null;
  provenanceHash: string | null;
  compilerContractVersion: string;
  health: ProjectKnowledgeHealth;
};

export type ProjectKnowledgeHealth = {
  freshness: string;
  provenance: string;
  compilerCompatibility: string;
  staleSince: string | null;
  staleReasons: unknown[];
  timeToRefreshMs: number | null;
  rawContextRequired: boolean;
  trustedCompiledRetrieval: boolean;
  warnings: string[];
};

export type ProjectKnowledgeConsumerContext = {
  knowledgeBase: ProjectKnowledgeBase | null;
  health: ProjectKnowledgeHealth | null;
  usage: "raw_only" | "raw_wins" | "trusted_compiled";
  promptNotice: string | null;
};

export type ProjectKnowledgeGeneratedDraft = {
  draftId: string;
  draftStatus: ProjectKnowledgeDraft["status"];
  blockers: ProjectKnowledgeDraft["blockers"];
  reviewSummary: ProjectKnowledgeDraft["reviewSummary"];
  promptVersion: string;
  provider: string;
  model: string;
  requestedMode: ProjectKnowledgeCompileMode;
  mode: ProjectKnowledgeCompileMode;
  fallbackReason?: string;
  sourceWorkItemCount: number;
  promptedSourceWorkItemCount: number;
  changedSourceWorkItemCount: number;
  changedSourceWorkItemIds: string[];
  retiredSourceWorkItemCount: number;
  retiredSourceWorkItemIds: string[];
  rawOutput: string;
  knowledgeBase: ProjectKnowledgeBase;
  generatedAt: string;
  alreadyCurrent?: boolean;
  warnings?: string[];
  tokenUsage?: LLMResult["tokenUsage"];
  splitCallCount: number;
  modelInputTokenLimit: number;
  inputTokenLimitSource: string;
  renderedPromptChars: number;
  automaticDuplicateConsolidationCount: number;
};

export async function extractAndSaveProjectKnowledgeBase(input: {
  scope: ProjectScope;
  actor: string;
  provider: LLMProvider;
  mode?: ProjectKnowledgeCompileMode;
}) {
  const draft = await previewGeneratedProjectKnowledgeBase({
    scope: input.scope,
    actor: input.actor,
    provider: input.provider,
    mode: input.mode,
  });
  writeAuditLog({
    workspaceId: input.scope.workspaceId,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
    azureProjectName: input.scope.azureProjectName,
    azureOrganizationUrl: input.scope.azureOrganizationUrl,
    entityType: "project_knowledge_draft",
    entityId: draft.draftId,
    actor: input.actor,
    action: "rag.extract_project_knowledge_base.compatibility",
    status: "Info",
    message: "Deprecated extract endpoint created a reviewable draft without publishing knowledge.",
    details: {
      requiresReview: true,
      automaticDuplicateConsolidationCount: draft.automaticDuplicateConsolidationCount,
    },
  });
  return draft;
}

export async function previewGeneratedProjectKnowledgeBase(input: {
  scope: ProjectScope;
  actor: string;
  provider: LLMProvider;
  mode?: ProjectKnowledgeCompileMode;
  parentDraftId?: string;
  baseKnowledgeBase?: ProjectKnowledgeBase;
}): Promise<ProjectKnowledgeGeneratedDraft> {
  const scope = assertProjectScope(input.scope);
  const startedAt = Date.now();
  const persistedDraft = await beginProjectKnowledgeDraft({
    scope,
    actor: input.actor,
    generationMode: "automatic",
    compilationMode: input.mode ?? "incremental",
    parentDraftId: input.parentDraftId,
  });
  const workItems = await loadProjectKnowledgeWorkItemsFromManifest(scope, persistedDraft.sourceManifest);
  if (!workItems.length) {
    await failProjectKnowledgeDraft({ scope, draftId: persistedDraft.id, reason: "missing_source_snapshots" });
    throw new Error("Fetch and index project context before extracting the knowledge base.");
  }

  try {

  const selection = await selectProjectKnowledgeWorkItemsForCompilation({
    scope,
    workItems,
    mode: input.mode ?? "incremental",
  });

  if (selection.mode === "incremental" && !selection.workItems.length) {
    const existingSnapshot = await getProjectKnowledgeBaseSnapshot({ scope });
    if (!existingSnapshot) throw new Error("Run a full knowledge recompile before incremental compilation.");

    const consolidation = selection.retiredSourceWorkItemIds.length
      ? mergeIncrementalProjectKnowledgeBase({
          existingKnowledgeBase: input.baseKnowledgeBase ?? existingSnapshot.knowledgeBase,
          partialKnowledgeBases: [],
          affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
          activeSourceWorkItemIds: workItems.map((item) => item.id),
        })
      : {
          knowledgeBase: input.baseKnowledgeBase ?? existingSnapshot.knowledgeBase,
          automaticDuplicateConsolidationCount: 0,
        };
    const knowledgeBase = consolidation.knowledgeBase;

    const generated = {
      promptVersion: projectKnowledgeExtractionPrompt.version,
      provider: "local",
      model: "local-deterministic",
      requestedMode: selection.requestedMode,
      mode: selection.mode,
      fallbackReason: selection.fallbackReason,
      sourceWorkItemCount: workItems.length,
      promptedSourceWorkItemCount: selection.workItems.length,
      changedSourceWorkItemCount: selection.changedSourceWorkItemIds.length,
      changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
      retiredSourceWorkItemCount: selection.retiredSourceWorkItemIds.length,
      retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
      rawOutput: JSON.stringify({
        mode: "incremental",
        noModelCall: true,
        retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
        automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
      }),
      knowledgeBase,
      generatedAt: nowIso(),
      alreadyCurrent: !selection.retiredSourceWorkItemIds.length,
      tokenUsage: { input: 0, output: 0, total: 0 },
      splitCallCount: 0,
      modelInputTokenLimit: input.provider.maxInputTokens ?? 16_000,
      inputTokenLimitSource: input.provider.inputTokenLimitSource ?? "unknown_fallback",
      renderedPromptChars: 0,
      automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
    };
    return completeGeneratedPreview({
      scope,
      draftId: persistedDraft.id,
      generated,
      sourceWorkItems: workItems,
      startedAt,
    });
  }

  const existingKnowledgeBase = input.baseKnowledgeBase ?? await getSavedProjectKnowledgeBase({ scope });
  const result = await extractProjectKnowledgeBase({
    scope,
    provider: input.provider,
    workItems: selection.workItems,
    mode: selection.mode,
    existingKnowledgeBase,
    onBatchCompleted: () => heartbeatProjectKnowledgeDraft({ scope, draftId: persistedDraft.id }),
  });
  const incrementalConsolidation = selection.mode === "incremental"
    ? mergeIncrementalProjectKnowledgeBase({
        existingKnowledgeBase: existingKnowledgeBase ?? await getRequiredExistingProjectKnowledgeBase(scope),
        partialKnowledgeBases: [result.validatedOutput],
        affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
        activeSourceWorkItemIds: workItems.map((item) => item.id),
      })
    : null;
  const knowledgeBase = incrementalConsolidation?.knowledgeBase ?? result.validatedOutput;
  const automaticDuplicateConsolidationCount = result.automaticDuplicateConsolidationCount +
    (incrementalConsolidation?.automaticDuplicateConsolidationCount ?? 0);

  const generated = {
    promptVersion: projectKnowledgeExtractionPrompt.version,
    provider: result.provider,
    model: result.model,
    requestedMode: selection.requestedMode,
    mode: selection.mode,
    fallbackReason: selection.fallbackReason,
    sourceWorkItemCount: workItems.length,
    promptedSourceWorkItemCount: selection.workItems.length,
    changedSourceWorkItemCount: selection.changedSourceWorkItemIds.length,
    changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
    retiredSourceWorkItemCount: selection.retiredSourceWorkItemIds.length,
    retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
    rawOutput: selection.mode === "incremental"
      ? JSON.stringify({
          mode: "incremental",
          changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
          retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
          extraction: result.rawOutput,
          automaticDuplicateConsolidationCount,
        })
      : result.rawOutput,
    knowledgeBase,
    generatedAt: nowIso(),
    warnings: result.warnings,
    tokenUsage: result.tokenUsage,
    splitCallCount: result.splitCallCount,
    modelInputTokenLimit: result.modelInputTokenLimit,
    inputTokenLimitSource: result.inputTokenLimitSource,
    renderedPromptChars: result.renderedPromptChars,
    automaticDuplicateConsolidationCount,
  };
  return completeGeneratedPreview({
    scope,
    draftId: persistedDraft.id,
    generated,
    sourceWorkItems: workItems,
    startedAt,
  });
  } catch (error) {
    await failProjectKnowledgeDraft({
      scope,
      draftId: persistedDraft.id,
      reason: error instanceof Error ? error.message : "generation_failed",
    });
    throw error;
  }
}

export async function rebaseProjectKnowledgeDraft(input: {
  scope: ProjectScope;
  actor: string;
  provider: LLMProvider;
  parentDraftId: string;
}) {
  const parent = await getProjectKnowledgeDraft({ scope: input.scope, draftId: input.parentDraftId });
  if (!parent) {
    throw new AppError({
      code: AppErrorCode.ResourceNotFound,
      message: "The parent knowledge draft was not found in the active project.",
      userMessage: "The parent knowledge draft was not found.",
    });
  }
  if (parent.generationMode === "manual") {
    const preparation = await buildProjectKnowledgeManualDraft({
      scope: input.scope,
      actor: input.actor,
      mode: parent.compilationMode === "incremental" ? "incremental" : "full",
      parentDraftId: parent.id,
    });
    const child = await getProjectKnowledgeDraft({ scope: input.scope, draftId: preparation.draftId });
    if (!child) throw new Error("The manual rebased child draft was not persisted.");
    return { ...child, manualPreparation: preparation };
  }
  const replay = await tryDeterministicProjectKnowledgeRebase({
    scope: input.scope,
    actor: input.actor,
    parentDraftId: input.parentDraftId,
  });
  if (replay.kind === "replayed") {
    if (replay.draft.persistedStatus !== "ready_for_review") return replay.draft;
    return publishProjectKnowledgeDraft({
      scope: input.scope,
      actor: input.actor,
      draftId: replay.draft.id,
      publicationIntent: "automatic_provenance_refresh",
    });
  }
  if (!parent.proposedKnowledge) {
    throw new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "The parent draft has no proposal to reconcile.",
      userMessage: "This draft has no proposal to rebase. Regenerate it.",
    });
  }
  const currentManifest = await loadCurrentProjectKnowledgeSourceManifest(input.scope);
  const refreshedParentKnowledge = refreshUnchangedProjectKnowledgeProvenance({
    knowledgeBase: parent.proposedKnowledge,
    previousManifest: parent.sourceManifest,
    currentManifest,
  });
  const generated = await previewGeneratedProjectKnowledgeBase({
    scope: input.scope,
    actor: input.actor,
    provider: input.provider,
    mode: "incremental",
    parentDraftId: input.parentDraftId,
    baseKnowledgeBase: refreshedParentKnowledge,
  });
  const child = await getProjectKnowledgeDraft({ scope: input.scope, draftId: generated.draftId });
  if (!child) throw new Error("The rebased child draft was not persisted.");
  if (child.persistedStatus !== "ready_for_review") return child;
  return publishProjectKnowledgeDraft({
    scope: input.scope,
    actor: input.actor,
    draftId: child.id,
    publicationIntent: "automatic_provenance_refresh",
  });
}

function refreshUnchangedProjectKnowledgeProvenance(input: {
  knowledgeBase: ProjectKnowledgeBase;
  previousManifest: ProjectKnowledgeDraft["sourceManifest"];
  currentManifest: ProjectKnowledgeDraft["sourceManifest"];
}) {
  const previousBySnapshot = new Map(input.previousManifest.map((entry) => [entry.sourceSnapshotId, entry]));
  const currentByWorkItem = new Map(input.currentManifest.map((entry) => [entry.sourceWorkItemId, entry]));
  const refreshRefs = (refs: ProjectKnowledgeBase["modules"][number]["evidenceRefs"]) => refs?.map((ref) => {
    const previous = previousBySnapshot.get(ref.sourceSnapshotId);
    const current = currentByWorkItem.get(ref.sourceWorkItemId);
    if (!previous || !current || previous.contentHash !== current.contentHash) return ref;
    return { ...ref, sourceSnapshotId: current.sourceSnapshotId };
  });
  return ProjectKnowledgeBaseSchema.parse({
    modules: input.knowledgeBase.modules.map((entry) => ({ ...entry, evidenceRefs: refreshRefs(entry.evidenceRefs) })),
    businessRules: input.knowledgeBase.businessRules.map((entry) => ({ ...entry, evidenceRefs: refreshRefs(entry.evidenceRefs) })),
    stateTransitions: input.knowledgeBase.stateTransitions.map((entry) => ({ ...entry, evidenceRefs: refreshRefs(entry.evidenceRefs) })),
    glossary: input.knowledgeBase.glossary.map((entry) => ({ ...entry, evidenceRefs: refreshRefs(entry.evidenceRefs) })),
    crossDependencies: input.knowledgeBase.crossDependencies.map((entry) => ({ ...entry, evidenceRefs: refreshRefs(entry.evidenceRefs) })),
  });
}

export async function saveGeneratedProjectKnowledgeBaseDraft(input: {
  scope: ProjectScope;
  actor: string;
  draftId: string;
}) {
  return publishProjectKnowledgeDraft(input);
}

async function completeGeneratedPreview(input: {
  scope: ProjectScope;
  draftId: string;
  generated: Omit<ProjectKnowledgeGeneratedDraft, "draftId" | "draftStatus" | "blockers" | "reviewSummary">;
  sourceWorkItems: ProjectKnowledgeWorkItem[];
  startedAt: number;
}): Promise<ProjectKnowledgeGeneratedDraft> {
  const sizeMetrics = buildProjectKnowledgeSizeMetrics(input.sourceWorkItems, input.generated.knowledgeBase);
  const completed = await completeProjectKnowledgeDraft({
    scope: input.scope,
    draftId: input.draftId,
    provider: input.generated.provider,
    model: input.generated.model,
    rawOutput: input.generated.rawOutput,
    knowledgeBase: input.generated.knowledgeBase,
    metrics: {
      ...sizeMetrics,
      renderedPromptChars: input.generated.renderedPromptChars,
      generationDurationMs: Date.now() - input.startedAt,
      splitCallCount: input.generated.splitCallCount,
      inputTokenLimit: input.generated.modelInputTokenLimit,
      inputTokenLimitSource: input.generated.inputTokenLimitSource,
      tokenUsage: input.generated.tokenUsage ?? null,
      rebaseCount: 0,
      conflictCount: null,
      automaticDuplicateConsolidationCount: input.generated.automaticDuplicateConsolidationCount,
    },
    touchedSourceWorkItemIds: input.generated.mode === "full"
      ? input.sourceWorkItems.map((item) => item.id)
      : Array.from(new Set([
          ...input.generated.changedSourceWorkItemIds,
          ...input.generated.retiredSourceWorkItemIds,
        ])),
  });
  return {
    ...input.generated,
    draftId: completed.id,
    draftStatus: completed.status,
    blockers: completed.blockers,
    reviewSummary: completed.reviewSummary,
  };
}

function buildProjectKnowledgeSizeMetrics(
  sourceWorkItems: ProjectKnowledgeWorkItem[],
  knowledgeBase: ProjectKnowledgeBase,
) {
  const normalizedSourceChars = sourceWorkItems.reduce(
    (total, item) => total + JSON.stringify(item).length,
    0,
  );
  const compiledChars = JSON.stringify(knowledgeBase).length;
  return {
    normalizedSourceChars,
    compiledChars,
    sourceToCompiledRatio: compiledChars ? normalizedSourceChars / compiledChars : null,
    compiledToSourceRatio: normalizedSourceChars ? compiledChars / normalizedSourceChars : null,
  };
}

export async function getProjectKnowledgeBaseSnapshot(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  await backfillProjectKnowledgeCompilerFoundation(scope);
  const row = await sqlGet<ProjectKnowledgeSnapshotRow>(
    `
      SELECT id, prompt_version, provider, model_name, source_work_item_count,
             raw_output, validated_output, status, error_details,
             extracted_at, created_at, updated_at, active_revision_id,
             source_fingerprint, semantic_hash, provenance_hash,
             compiler_contract_version, freshness_status, provenance_status,
             compiler_compatibility, stale_since, stale_reason_json
      FROM project_knowledge_base
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      LIMIT 1
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );

  return row ? toProjectKnowledgeSnapshot(row) : null;
}

export async function loadProjectKnowledgeContext(input: {
  scope: ProjectScope;
  consumer?: string;
}): Promise<ProjectKnowledgeConsumerContext> {
  const snapshot = await getProjectKnowledgeBaseSnapshot(input);
  if (!snapshot) return { knowledgeBase: null, health: null, usage: "raw_only", promptNotice: null };
  const usage = snapshot.health.trustedCompiledRetrieval ? "trusted_compiled" as const : "raw_wins" as const;
  const promptNotice = snapshot.health.rawContextRequired
    ? [
        "Knowledge authority notice:",
        `Compiled project knowledge is ${snapshot.health.freshness}, ${snapshot.health.provenance}, and ${snapshot.health.compilerCompatibility}.`,
        "Treat current raw work-item evidence as authoritative; it wins every conflict with compiled knowledge.",
      ].join(" ")
    : null;
  if (input.consumer) {
    recordProjectKnowledgeLog({
      scope: input.scope,
      eventType: "knowledge.consumed",
      severity: snapshot.health.warnings.length ? "warning" : "info",
      title: "Project knowledge consumed",
      message: `${input.consumer} loaded project knowledge in ${usage} mode.`,
      metadata: {
        consumer: input.consumer,
        usage,
        freshness: snapshot.health.freshness,
        provenance: snapshot.health.provenance,
        compilerCompatibility: snapshot.health.compilerCompatibility,
      },
    });
  }
  return { knowledgeBase: snapshot.knowledgeBase, health: snapshot.health, usage, promptNotice };
}

export async function getSavedProjectKnowledgeBase(input: { scope: ProjectScope; consumer?: string }) {
  return (await loadProjectKnowledgeContext(input)).knowledgeBase;
}

export async function buildProjectKnowledgeManualDraft(input: {
  scope: ProjectScope;
  actor?: string;
  mode?: ProjectKnowledgeCompileMode;
  parentDraftId?: string;
}) {
  const scope = assertProjectScope(input.scope);
  const persistedDraft = await beginProjectKnowledgeDraft({
    scope,
    actor: input.actor ?? "system",
    generationMode: "manual",
    compilationMode: input.mode ?? "full",
    parentDraftId: input.parentDraftId,
  });
  const workItems = await loadProjectKnowledgeWorkItemsFromManifest(scope, persistedDraft.sourceManifest);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before extracting the knowledge base.");
  }
  const selection = await selectProjectKnowledgeWorkItemsForCompilation({
    scope,
    workItems,
    mode: input.mode ?? "full",
  });
  await setProjectKnowledgeDraftCompilationMode({
    scope,
    draftId: persistedDraft.id,
    compilationMode: selection.mode,
  });

  const parent = input.parentDraftId
    ? await getProjectKnowledgeDraft({ scope, draftId: input.parentDraftId })
    : null;
  const existingKnowledgeBase = parent?.proposedKnowledge ?? await getSavedProjectKnowledgeBase({ scope });
  const batches = selection.workItems.length
    ? buildProjectKnowledgeExtractionJobs({
        scope,
        workItems: selection.workItems,
        existingKnowledgeBase,
        mode: selection.mode,
        maxInputTokens: 16_000,
      })
    : [];
  const batchPrompts = batches.map((batch, index) => {
    const batchIndex = index + 1;
    const batchMetadata = batches.length > 1 ? { batchIndex, batchCount: batches.length } : {};
    const userPrompt = buildProjectKnowledgeExtractionUserPrompt({
      scope,
      workItems: batch.workItems,
      relevantExistingKnowledge: batch.relevantExistingKnowledge,
      mode: selection.mode,
      ...batchMetadata,
    });

    return {
      batchIndex,
      batchCount: batches.length,
      workItemCount: batch.workItems.length,
      systemPrompt: projectKnowledgeExtractionPrompt.system,
      userPrompt,
      prompt: buildManualPromptMarkdown({
        title: buildManualKnowledgePromptTitle(selection.mode, batchIndex, batches.length),
        system: projectKnowledgeExtractionPrompt.system,
        user: userPrompt,
      }),
    };
  });
  const stored = await storeProjectKnowledgeManualDraftBatches({
    scope,
    draftId: persistedDraft.id,
    batches: batchPrompts,
  });
  const carriedByIndex = new Map(stored.carriedBatches.map((batch) => [batch.batchIndex, batch]));

  return {
    draftId: persistedDraft.id,
    draftStatus: persistedDraft.status,
    schemaName: "ProjectKnowledgeBase",
    promptName: projectKnowledgeExtractionPrompt.name,
    promptVersion: projectKnowledgeExtractionPrompt.version,
    requestedMode: selection.requestedMode,
    mode: selection.mode,
    fallbackReason: selection.fallbackReason,
    sourceWorkItemCount: selection.workItems.length,
    totalSourceWorkItemCount: workItems.length,
    changedSourceWorkItemCount: selection.changedSourceWorkItemIds.length,
    retiredSourceWorkItemCount: selection.retiredSourceWorkItemIds.length,
    batchCount: batches.length,
    batches: batchPrompts.map((batch) => ({
      ...batch,
      carriedForward: carriedByIndex.has(batch.batchIndex),
      carriedRawOutput: carriedByIndex.get(batch.batchIndex)?.rawOutput,
      carriedKnowledgeBase: carriedByIndex.get(batch.batchIndex)?.validatedOutput,
    })),
  };
}

export function buildProjectKnowledgeManualConsolidationPrompt(input: {
  scope: ProjectScope;
  partialKnowledgeBases: ProjectKnowledgeBase[];
}) {
  const scope = assertProjectScope(input.scope);
  const userPrompt = buildProjectKnowledgeConsolidationUserPrompt({
    scope,
    partialKnowledgeBases: input.partialKnowledgeBases,
  });

  return {
    schemaName: "ProjectKnowledgeBase",
    promptName: projectKnowledgeConsolidationPrompt.name,
    promptVersion: projectKnowledgeConsolidationPrompt.version,
    systemPrompt: projectKnowledgeConsolidationPrompt.system,
    userPrompt,
    prompt: buildManualPromptMarkdown({
      title: "iTestFlow Knowledge Base Consolidation",
      system: projectKnowledgeConsolidationPrompt.system,
      user: userPrompt,
    }),
  };
}

export function validateProjectKnowledgeExternalOutput(rawOutput: string) {
  return parseExternalStructuredOutput({
    schemaName: "ProjectKnowledgeBase",
    schema: ProjectKnowledgeBaseSchema,
    rawOutput,
  });
}

export async function saveManualProjectKnowledgeBaseSnapshot(input: {
  scope: ProjectScope;
  actor: string;
  rawOutput: string;
  mode?: ProjectKnowledgeCompileMode;
}) {
  const scope = assertProjectScope(input.scope);
  const draft = await beginProjectKnowledgeDraft({
    scope,
    actor: input.actor,
    generationMode: "manual",
    compilationMode: input.mode ?? "full",
  });
  const workItems = await loadProjectKnowledgeWorkItemsFromManifest(scope, draft.sourceManifest);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before saving the knowledge base.");
  }

  const knowledgeBase = validateProjectKnowledgeExternalOutput(input.rawOutput);
  const saveResult = await prepareProjectKnowledgeManualSave({
    scope,
    sourceWorkItems: workItems,
    partialKnowledgeBases: [knowledgeBase],
    rawOutput: input.rawOutput,
    mode: input.mode ?? "full",
  });
  const completed = await completeProjectKnowledgeDraft({
    scope,
    draftId: draft.id,
    provider: "external",
    model: "manual-external",
    rawOutput: saveResult.rawOutput,
    knowledgeBase: saveResult.knowledgeBase,
    metrics: {
      ...buildProjectKnowledgeSizeMetrics(workItems, saveResult.knowledgeBase),
      splitCallCount: 1,
      renderedPromptChars: 0,
      automaticDuplicateConsolidationCount: saveResult.automaticDuplicateConsolidationCount,
    },
    touchedSourceWorkItemIds: saveResult.mode === "full"
      ? workItems.map((item) => item.id)
      : [...saveResult.changedSourceWorkItemIds, ...saveResult.retiredSourceWorkItemIds],
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "rag.extract_project_knowledge_base.manual_complete",
    status: "Success",
    message: "Prepared a reviewable project knowledge draft from validated external LLM output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: projectKnowledgeExtractionPrompt.version,
      requestedMode: input.mode ?? "full",
      mode: saveResult.mode,
      promptedSourceWorkItemCount: saveResult.promptedSourceWorkItemCount,
      changedSourceWorkItemIds: saveResult.changedSourceWorkItemIds,
      retiredSourceWorkItemIds: saveResult.retiredSourceWorkItemIds,
      sourceWorkItemCount: workItems.length,
      counts: getKnowledgeCounts(saveResult.knowledgeBase),
      automaticDuplicateConsolidationCount: saveResult.automaticDuplicateConsolidationCount,
    },
  });

  if (!completed.knowledgeBase) throw new Error("Manual draft completed without proposed knowledge.");
  return { ...completed, knowledgeBase: completed.knowledgeBase };
}

export async function saveManualProjectKnowledgeBaseFromBatches(input: {
  scope: ProjectScope;
  actor: string;
  draftId?: string;
  partialKnowledgeBases: ProjectKnowledgeBase[];
  mode?: ProjectKnowledgeCompileMode;
}) {
  const scope = assertProjectScope(input.scope);
  const draft = input.draftId
    ? await getProjectKnowledgeDraft({ scope, draftId: input.draftId })
    : await beginProjectKnowledgeDraft({
        scope,
        actor: input.actor,
        generationMode: "manual",
        compilationMode: input.mode ?? "full",
      });
  if (!draft) {
    throw new AppError({
      code: AppErrorCode.ResourceNotFound,
      message: "The knowledge draft was not found in the active project.",
      userMessage: "The knowledge draft was not found.",
    });
  }
  const draftId = draft.id;
  const persistedBatches = input.draftId
    ? await loadProjectKnowledgeManualBatchResults({ scope, draftId })
    : null;
  if (persistedBatches && persistedBatches.validatedCount !== persistedBatches.batchCount) {
    throw new Error("Validate every persisted manual batch before finalizing the knowledge draft.");
  }
  const partialKnowledgeBases = persistedBatches
    ? persistedBatches.partialKnowledgeBases
    : input.partialKnowledgeBases;
  const workItems = await loadProjectKnowledgeWorkItemsFromManifest(scope, draft.sourceManifest);
  if (!workItems.length) {
    throw new Error("Fetch and index project context before saving the knowledge base.");
  }
  if (!partialKnowledgeBases.length && (input.mode ?? "full") !== "incremental") {
    throw new Error("Validate at least one batch response before saving the knowledge base.");
  }

  const saveResult = await prepareProjectKnowledgeManualSave({
    scope,
    sourceWorkItems: workItems,
    partialKnowledgeBases,
    mode: input.mode ?? "full",
  });
  const rawOutput = JSON.stringify({
    consolidationMode: "local-deterministic",
    mode: saveResult.mode,
    changedSourceWorkItemIds: saveResult.changedSourceWorkItemIds,
    retiredSourceWorkItemIds: saveResult.retiredSourceWorkItemIds,
    automaticDuplicateConsolidationCount: saveResult.automaticDuplicateConsolidationCount,
    partialKnowledgeBases,
    consolidatedKnowledgeBase: saveResult.knowledgeBase,
  });
  const completed = await completeProjectKnowledgeDraft({
    scope,
    draftId,
    provider: "external",
    model: "manual-external",
    rawOutput,
    knowledgeBase: saveResult.knowledgeBase,
    metrics: {
      ...buildProjectKnowledgeSizeMetrics(workItems, saveResult.knowledgeBase),
      splitCallCount: partialKnowledgeBases.length,
      renderedPromptChars: persistedBatches?.renderedPromptChars ?? 0,
      automaticDuplicateConsolidationCount: saveResult.automaticDuplicateConsolidationCount,
    },
    touchedSourceWorkItemIds: saveResult.mode === "full"
      ? workItems.map((item) => item.id)
      : [...saveResult.changedSourceWorkItemIds, ...saveResult.retiredSourceWorkItemIds],
  });

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "rag.extract_project_knowledge_base.manual_batch_complete",
    status: "Success",
    message: "Prepared a reviewable project knowledge draft from locally consolidated external LLM batch output.",
    details: {
      provider: "external",
      model: "manual-external",
      promptVersion: projectKnowledgeExtractionPrompt.version,
      requestedMode: input.mode ?? "full",
      mode: saveResult.mode,
      sourceWorkItemCount: workItems.length,
      promptedSourceWorkItemCount: saveResult.promptedSourceWorkItemCount,
      changedSourceWorkItemIds: saveResult.changedSourceWorkItemIds,
      retiredSourceWorkItemIds: saveResult.retiredSourceWorkItemIds,
      batchCount: partialKnowledgeBases.length,
      counts: getKnowledgeCounts(saveResult.knowledgeBase),
      automaticDuplicateConsolidationCount: saveResult.automaticDuplicateConsolidationCount,
    },
  });

  if (!completed.knowledgeBase) throw new Error("Manual draft completed without proposed knowledge.");
  return { ...completed, knowledgeBase: completed.knowledgeBase };
}

type ProjectKnowledgeWorkItemSelection = {
  requestedMode: ProjectKnowledgeCompileMode;
  mode: ProjectKnowledgeCompileMode;
  fallbackReason?: string;
  workItems: ProjectKnowledgeWorkItem[];
  changedSourceWorkItemIds: string[];
  retiredSourceWorkItemIds: string[];
  affectedSourceWorkItemIds: string[];
};

async function selectProjectKnowledgeWorkItemsForCompilation(input: {
  scope: ProjectScope;
  workItems: ProjectKnowledgeWorkItem[];
  mode: ProjectKnowledgeCompileMode;
}): Promise<ProjectKnowledgeWorkItemSelection> {
  if (input.mode === "full") {
    return {
      requestedMode: input.mode,
      mode: "full",
      workItems: input.workItems,
      changedSourceWorkItemIds: input.workItems.map((item) => item.id),
      retiredSourceWorkItemIds: [],
      affectedSourceWorkItemIds: input.workItems.map((item) => item.id),
    };
  }

  const existingSnapshot = await getProjectKnowledgeBaseSnapshot({ scope: input.scope });
  if (!existingSnapshot) {
    return {
      requestedMode: input.mode,
      mode: "full",
      fallbackReason: "No saved knowledge base exists yet, so the first compile must include every active work item.",
      workItems: input.workItems,
      changedSourceWorkItemIds: input.workItems.map((item) => item.id),
      retiredSourceWorkItemIds: [],
      affectedSourceWorkItemIds: input.workItems.map((item) => item.id),
    };
  }

  const previousSourceHashes = await loadLatestProjectKnowledgeSourceHashes(input.scope);
  if (!previousSourceHashes) {
    return selectProjectKnowledgeWorkItemsFromSnapshotTimestamp({
      requestedMode: input.mode,
      existingSnapshot,
      workItems: input.workItems,
    });
  }

  const currentSourceHashes = buildSourceWorkItemHashMap(input.workItems);
  const changedSourceWorkItemIds = input.workItems
    .filter((item) => previousSourceHashes[item.id] !== currentSourceHashes[item.id])
    .map((item) => item.id);
  const currentSourceIds = new Set(input.workItems.map((item) => item.id));
  const retiredSourceWorkItemIds = Object.keys(previousSourceHashes).filter((sourceId) => !currentSourceIds.has(sourceId));
  const affectedSourceWorkItemIds = Array.from(new Set([...changedSourceWorkItemIds, ...retiredSourceWorkItemIds]));

  return {
    requestedMode: input.mode,
    mode: "incremental",
    workItems: input.workItems.filter((item) => changedSourceWorkItemIds.includes(item.id)),
    changedSourceWorkItemIds,
    retiredSourceWorkItemIds,
    affectedSourceWorkItemIds,
  };
}

function selectProjectKnowledgeWorkItemsFromSnapshotTimestamp(input: {
  requestedMode: ProjectKnowledgeCompileMode;
  existingSnapshot: ProjectKnowledgeSnapshot;
  workItems: ProjectKnowledgeWorkItem[];
}): ProjectKnowledgeWorkItemSelection {
  const extractedAtMs = Date.parse(input.existingSnapshot.extractedAt);
  const changedSourceWorkItemIds = Number.isFinite(extractedAtMs)
    ? input.workItems
        .filter((item) => {
          const updatedAtMs = Date.parse(item.updatedDate ?? "");
          return Number.isFinite(updatedAtMs) && updatedAtMs > extractedAtMs;
        })
        .map((item) => item.id)
    : [];
  const activeSourceIds = new Set(input.workItems.map((item) => item.id));
  const retiredSourceWorkItemIds = getKnowledgeSourceWorkItemIds(input.existingSnapshot.knowledgeBase)
    .filter((sourceId) => !activeSourceIds.has(sourceId));
  const affectedSourceWorkItemIds = Array.from(new Set([...changedSourceWorkItemIds, ...retiredSourceWorkItemIds]));

  return {
    requestedMode: input.requestedMode,
    mode: "incremental",
    fallbackReason: "The saved knowledge revision does not include source hashes yet, so Compile Prompt used the saved extraction time as its baseline. Save the no-prompt baseline once to enable exact hash-based incremental prompts.",
    workItems: input.workItems.filter((item) => changedSourceWorkItemIds.includes(item.id)),
    changedSourceWorkItemIds,
    retiredSourceWorkItemIds,
    affectedSourceWorkItemIds,
  };
}

async function prepareProjectKnowledgeManualSave(input: {
  scope: ProjectScope;
  sourceWorkItems: ProjectKnowledgeWorkItem[];
  partialKnowledgeBases: ProjectKnowledgeBase[];
  rawOutput?: string;
  mode: ProjectKnowledgeCompileMode;
}) {
  const selection = await selectProjectKnowledgeWorkItemsForCompilation({
    scope: input.scope,
    workItems: input.sourceWorkItems,
    mode: input.mode,
  });
  const mode: ProjectKnowledgeCompileMode = input.mode === "incremental" && selection.mode === "incremental" ? "incremental" : "full";
  if (!input.partialKnowledgeBases.length && mode !== "incremental") {
    throw new Error("Validate at least one batch response before saving the knowledge base.");
  }

  const consolidation = mode === "incremental"
    ? mergeIncrementalProjectKnowledgeBase({
        existingKnowledgeBase: await getRequiredExistingProjectKnowledgeBase(input.scope),
        partialKnowledgeBases: input.partialKnowledgeBases,
        affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
        activeSourceWorkItemIds: input.sourceWorkItems.map((item) => item.id),
      })
    : consolidateProjectKnowledgeBases(input.partialKnowledgeBases);
  const knowledgeBase = consolidation.knowledgeBase;
  const sourceChangeSummary = buildCompilationSourceChangeSummary({
    knowledgeBase,
    sourceWorkItems: input.sourceWorkItems,
    selection: {
      ...selection,
      mode,
    },
  });

  return {
    mode,
    knowledgeBase,
    rawOutput: mode === "incremental"
      ? JSON.stringify({
          mode,
          changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
          retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
          automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
          externalOutput: input.rawOutput,
          partialKnowledgeBases: input.partialKnowledgeBases,
          consolidatedKnowledgeBase: knowledgeBase,
        })
      : input.rawOutput ?? JSON.stringify({
          mode,
          automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
          partialKnowledgeBases: input.partialKnowledgeBases,
          consolidatedKnowledgeBase: knowledgeBase,
        }),
    sourceChangeSummary,
    promptedSourceWorkItemCount: mode === "incremental" ? selection.workItems.length : input.sourceWorkItems.length,
    changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
    retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
    automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
  };
}

function mergeIncrementalProjectKnowledgeBase(input: {
  existingKnowledgeBase: ProjectKnowledgeBase;
  partialKnowledgeBases: ProjectKnowledgeBase[];
  affectedSourceWorkItemIds: string[];
  activeSourceWorkItemIds: string[];
}) {
  const affectedSourceIds = new Set(input.affectedSourceWorkItemIds);
  const activeSourceIds = new Set(input.activeSourceWorkItemIds);
  const retainedKnowledgeBase = pruneKnowledgeBaseBySource(input.existingKnowledgeBase, affectedSourceIds, activeSourceIds);
  return consolidateProjectKnowledgeBases([retainedKnowledgeBase, ...input.partialKnowledgeBases]);
}

function pruneKnowledgeBaseBySource(
  knowledgeBase: ProjectKnowledgeBase,
  affectedSourceIds: Set<string>,
  activeSourceIds: Set<string>,
): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: pruneSourceBackedItems(knowledgeBase.modules, affectedSourceIds, activeSourceIds),
    businessRules: pruneSourceBackedItems(knowledgeBase.businessRules, affectedSourceIds, activeSourceIds),
    stateTransitions: pruneSourceBackedItems(knowledgeBase.stateTransitions, affectedSourceIds, activeSourceIds),
    glossary: pruneSourceBackedItems(knowledgeBase.glossary, affectedSourceIds, activeSourceIds),
    crossDependencies: pruneSourceBackedItems(knowledgeBase.crossDependencies, affectedSourceIds, activeSourceIds),
  });
}

function pruneSourceBackedItems<TItem extends { sourceWorkItemIds: string[]; evidenceRefs?: ProjectKnowledgeBase["modules"][number]["evidenceRefs"] }>(
  items: TItem[],
  affectedSourceIds: Set<string>,
  activeSourceIds: Set<string>,
) {
  return items
    .map((item) => {
      const sourceWorkItemIds = item.sourceWorkItemIds.filter((sourceId) => activeSourceIds.has(sourceId) && !affectedSourceIds.has(sourceId));
      if (sourceWorkItemIds.length === item.sourceWorkItemIds.length) return item;
      if (!sourceWorkItemIds.length) return null;
      return {
        ...item,
        sourceWorkItemIds,
        evidenceRefs: item.evidenceRefs?.filter((ref) => sourceWorkItemIds.includes(ref.sourceWorkItemId)),
      };
    })
    .filter((item): item is TItem => Boolean(item));
}

async function getRequiredExistingProjectKnowledgeBase(scope: ProjectScope) {
  const existingSnapshot = await getProjectKnowledgeBaseSnapshot({ scope });
  if (!existingSnapshot) throw new Error("Run a full knowledge recompile before incremental compilation.");
  return existingSnapshot.knowledgeBase;
}

function buildCompilationSourceChangeSummary(input: {
  knowledgeBase: ProjectKnowledgeBase;
  sourceWorkItems: ProjectKnowledgeWorkItem[];
  selection?: Partial<ProjectKnowledgeWorkItemSelection>;
}) {
  const knowledgeCounts = getKnowledgeCounts(input.knowledgeBase);
  return {
    ...knowledgeCounts,
    knowledgeCounts,
    sourceWorkItemIds: input.sourceWorkItems.map((item) => item.id),
    sourceWorkItemHashes: buildSourceWorkItemHashMap(input.sourceWorkItems),
    totalSourceWorkItemCount: input.sourceWorkItems.length,
    requestedMode: input.selection?.requestedMode,
    mode: input.selection?.mode,
    fallbackReason: input.selection?.fallbackReason,
    promptedSourceWorkItemCount: input.selection?.workItems?.length ?? input.sourceWorkItems.length,
    changedSourceWorkItemIds: input.selection?.changedSourceWorkItemIds ?? [],
    retiredSourceWorkItemIds: input.selection?.retiredSourceWorkItemIds ?? [],
  };
}

function buildSourceWorkItemHashMap(workItems: ProjectKnowledgeWorkItem[]): ProjectKnowledgeSourceHashMap {
  return Object.fromEntries(workItems.map((item) => [item.id, item.contentHash ?? null]));
}

function getKnowledgeSourceWorkItemIds(knowledgeBase: ProjectKnowledgeBase) {
  return Array.from(new Set([
    ...knowledgeBase.modules.flatMap((item) => item.sourceWorkItemIds),
    ...knowledgeBase.businessRules.flatMap((item) => item.sourceWorkItemIds),
    ...knowledgeBase.stateTransitions.flatMap((item) => item.sourceWorkItemIds),
    ...knowledgeBase.glossary.flatMap((item) => item.sourceWorkItemIds),
    ...knowledgeBase.crossDependencies.flatMap((item) => item.sourceWorkItemIds),
  ].map((sourceId) => sourceId.trim()).filter(Boolean)));
}

async function loadLatestProjectKnowledgeSourceHashes(scope: ProjectScope): Promise<ProjectKnowledgeSourceHashMap | null> {
  const row = await sqlGet<{ source_change_summary_json: string | null }>(
    `
      SELECT source_change_summary_json
      FROM project_knowledge_revisions
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY revision_number DESC
      LIMIT 1
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );

  if (!row?.source_change_summary_json) return null;
  try {
    const parsed = JSON.parse(row.source_change_summary_json) as { sourceWorkItemHashes?: unknown };
    if (!parsed.sourceWorkItemHashes || Array.isArray(parsed.sourceWorkItemHashes) || typeof parsed.sourceWorkItemHashes !== "object") {
      return null;
    }
    const hashes: ProjectKnowledgeSourceHashMap = {};
    Object.entries(parsed.sourceWorkItemHashes as Record<string, unknown>).forEach(([sourceId, hash]) => {
      if (typeof hash === "string" || hash === null) hashes[sourceId] = hash;
    });
    return Object.keys(hashes).length ? hashes : null;
  } catch {
    return null;
  }
}

function buildManualKnowledgePromptTitle(mode: ProjectKnowledgeCompileMode, batchIndex: number, batchCount: number) {
  const title = mode === "incremental"
    ? "iTestFlow Knowledge Base Compile"
    : "iTestFlow Knowledge Base Full Recompile";
  return batchCount > 1 ? `${title} - Batch ${batchIndex} of ${batchCount}` : title;
}

function toPromptWorkItem(item: ProjectKnowledgeWorkItem) {
  return {
    id: item.id,
    sourceSnapshotId: item.sourceSnapshotId,
    workItemType: item.workItemType,
    title: item.title,
    state: item.state,
    description: item.description,
    acceptanceCriteria: item.acceptanceCriteria,
    tags: item.tags,
    areaPath: item.areaPath,
    iterationPath: item.iterationPath,
    updatedDate: item.updatedDate,
  };
}

type ProjectKnowledgeConsolidationResult = {
  knowledgeBase: ProjectKnowledgeBase;
  automaticDuplicateConsolidationCount: number;
};

function consolidateProjectKnowledgeBases(
  partialKnowledgeBases: ProjectKnowledgeBase[],
): ProjectKnowledgeConsolidationResult {
  const modules = consolidateCategoryItems(
    "module",
    partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.modules),
    (item) => [
      `id:${canonicalizeProjectKnowledgeLogicalIdentity(item.id)}`,
      `name:${canonicalizeProjectKnowledgeLogicalIdentity(item.name)}`,
    ],
  );
  const businessRules = consolidateCategoryItems(
    "business_rule",
    partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.businessRules),
    (item) => [
      `id:${canonicalizeProjectKnowledgeLogicalIdentity(item.id)}`,
      `rule:${canonicalizeProjectKnowledgeLogicalIdentity(item.rule)}`,
    ],
  );
  const stateTransitions = consolidateCategoryItems(
    "state_transition",
    partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.stateTransitions),
    (item) => [
      `id:${canonicalizeProjectKnowledgeLogicalIdentity(item.id)}`,
      `transition:${canonicalizeProjectKnowledgeLogicalIdentity([
        item.workflowName,
        item.fromState,
        item.toState,
        item.triggerOrCondition,
      ].filter(Boolean).join(" "))}`,
    ],
  );
  const glossary = consolidateCategoryItems(
    "glossary",
    partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.glossary),
    (item) => [`term:${canonicalizeProjectKnowledgeLogicalIdentity(item.term)}`],
  );
  const crossDependencies = consolidateCategoryItems(
    "dependency",
    partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.crossDependencies),
    (item) => [
      `id:${canonicalizeProjectKnowledgeLogicalIdentity(item.id)}`,
      `dependency:${canonicalizeProjectKnowledgeLogicalIdentity([
        item.sourceModule,
        item.targetModule,
        item.dependencyType,
      ].join(" "))}`,
    ],
  );

  return {
    knowledgeBase: ProjectKnowledgeBaseSchema.parse({
      modules: modules.items,
      businessRules: businessRules.items,
      stateTransitions: stateTransitions.items,
      glossary: glossary.items,
      crossDependencies: crossDependencies.items,
    }),
    automaticDuplicateConsolidationCount: [
      modules,
      businessRules,
      stateTransitions,
      glossary,
      crossDependencies,
    ].reduce((total, result) => total + result.automaticDuplicateConsolidationCount, 0),
  };
}

function consolidateCategoryItems<TCategory extends ProjectKnowledgeConsolidationCategory>(
  category: TCategory,
  items: ProjectKnowledgeEntryByConsolidationCategory[TCategory][],
  getCandidateKeys: (item: ProjectKnowledgeEntryByConsolidationCategory[TCategory]) => string[],
) {
  const parents = items.map((_, index) => index);
  const indexesByCandidateKey = new Map<string, number[]>();
  items.forEach((item, index) => {
    new Set(getCandidateKeys(item).filter((key) => key && !key.endsWith(":"))).forEach((key) => {
      const indexes = indexesByCandidateKey.get(key) ?? [];
      indexes.push(index);
      indexesByCandidateKey.set(key, indexes);
    });
  });
  const find = (index: number): number => {
    const parent = parents[index];
    if (parent === index) return index;
    parents[index] = find(parent);
    return parents[index];
  };
  const union = (first: number, second: number) => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot;
  };

  const comparedPairs = new Set<string>();
  for (const indexes of indexesByCandidateKey.values()) {
    for (let firstOffset = 0; firstOffset < indexes.length; firstOffset += 1) {
      for (let secondOffset = firstOffset + 1; secondOffset < indexes.length; secondOffset += 1) {
        const first = indexes[firstOffset];
        const second = indexes[secondOffset];
        const pairKey = `${first}:${second}`;
        if (comparedPairs.has(pairKey)) continue;
        comparedPairs.add(pairKey);
        if (shouldAutomaticallyConsolidate(category, items[first], items[second])) {
          union(first, second);
        }
      }
    }
  }

  const groups = new Map<number, ProjectKnowledgeEntryByConsolidationCategory[TCategory][]>();
  items.forEach((item, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(item);
    groups.set(root, group);
  });
  const consolidatedItems = Array.from(groups.values()).map((entries) =>
    mergeProjectKnowledgeConflictEntries(category, entries),
  );

  return {
    items: consolidatedItems,
    automaticDuplicateConsolidationCount: items.length - consolidatedItems.length,
  };
}

function shouldAutomaticallyConsolidate<TCategory extends ProjectKnowledgeConsolidationCategory>(
  category: TCategory,
  first: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
  second: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
) {
  if (normalizedProjection(category, first) === normalizedProjection(category, second)) return true;

  if (category === "module" || category === "glossary") {
    return haveSameNonEmptySnapshotSet(first, second);
  }

  return false;
}

function normalizedProjection<TCategory extends ProjectKnowledgeConsolidationCategory>(
  category: TCategory,
  entry: ProjectKnowledgeEntryByConsolidationCategory[TCategory],
) {
  switch (category) {
    case "module": {
      const moduleEntry = entry as ProjectKnowledgeEntryByConsolidationCategory["module"];
      return projectionKey(moduleEntry.name, moduleEntry.description);
    }
    case "business_rule": {
      const rule = entry as ProjectKnowledgeEntryByConsolidationCategory["business_rule"];
      return projectionKey(rule.rule, normalizeBusinessRuleSourceField(rule.sourceField), rule.moduleName);
    }
    case "state_transition": {
      const transition = entry as ProjectKnowledgeEntryByConsolidationCategory["state_transition"];
      return projectionKey(
        transition.workflowName,
        transition.fromState,
        transition.toState,
        transition.triggerOrCondition,
        transition.actor,
        transition.moduleName,
      );
    }
    case "glossary": {
      const term = entry as ProjectKnowledgeEntryByConsolidationCategory["glossary"];
      return projectionKey(
        canonicalizeProjectKnowledgeLogicalIdentity(term.term),
        term.type,
        term.definition,
      );
    }
    case "dependency": {
      const dependency = entry as ProjectKnowledgeEntryByConsolidationCategory["dependency"];
      return projectionKey(
        dependency.sourceModule,
        dependency.targetModule,
        dependency.dependencyType,
        dependency.description,
      );
    }
  }
}

function projectionKey(...values: Array<string | undefined>) {
  return values.map(normalizeComparableText).join("\u0000");
}

function normalizeComparableText(value: string | undefined) {
  return value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") ?? "";
}

function normalizeBusinessRuleSourceField(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (["acceptancecriterion", "acceptancecriteria", "criteria", "ac"].includes(normalized)) {
    return "acceptanceCriteria";
  }
  if (["desc", "systemdescription"].includes(normalized)) return "description";
  if (["name", "systemtitle"].includes(normalized)) return "title";
  return normalized;
}

function haveSameNonEmptySnapshotSet(
  first: Pick<ProjectKnowledgeBase["modules"][number], "evidenceRefs">,
  second: Pick<ProjectKnowledgeBase["modules"][number], "evidenceRefs">,
) {
  const firstSnapshotIds = sourceSnapshotIds(first);
  const secondSnapshotIds = sourceSnapshotIds(second);
  return firstSnapshotIds.length > 0 &&
    firstSnapshotIds.length === secondSnapshotIds.length &&
    firstSnapshotIds.every((snapshotId, index) => snapshotId === secondSnapshotIds[index]);
}

function sourceSnapshotIds(entry: Pick<ProjectKnowledgeBase["modules"][number], "evidenceRefs">) {
  return Array.from(new Set((entry.evidenceRefs ?? []).map((ref) => ref.sourceSnapshotId))).sort();
}

async function extractProjectKnowledgeBase(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  workItems: ProjectKnowledgeWorkItem[];
  mode: ProjectKnowledgeCompileMode;
  existingKnowledgeBase: ProjectKnowledgeBase | null;
  onBatchCompleted?: () => Promise<void>;
}): Promise<LLMResult<ProjectKnowledgeBase> & {
  splitCallCount: number;
  modelInputTokenLimit: number;
  inputTokenLimitSource: string;
  renderedPromptChars: number;
  automaticDuplicateConsolidationCount: number;
}> {
  const jobs = buildProjectKnowledgeExtractionJobs({
    scope: input.scope,
    workItems: input.workItems,
    existingKnowledgeBase: input.existingKnowledgeBase,
    mode: input.mode,
    maxInputTokens: input.provider.maxInputTokens ?? 16_000,
  });
  const renderedPromptChars = jobs.reduce((total, job, index) => total + renderedKnowledgeJobChars({
    scope: input.scope,
    workItems: job.workItems,
    relevantExistingKnowledge: job.relevantExistingKnowledge,
    mode: input.mode,
    batchIndex: jobs.length > 1 ? index + 1 : undefined,
    batchCount: jobs.length > 1 ? jobs.length : undefined,
  }), 0);
  if (jobs.length === 1) {
    const result = await extractProjectKnowledgeBatch({
      scope: input.scope,
      provider: input.provider,
      workItems: jobs[0].workItems,
      relevantExistingKnowledge: jobs[0].relevantExistingKnowledge,
      mode: input.mode,
    });
    await input.onBatchCompleted?.();
    const consolidation = consolidateProjectKnowledgeBases([result.validatedOutput]);
    return {
      ...result,
      validatedOutput: consolidation.knowledgeBase,
      rawOutput: JSON.stringify({
        mode: input.mode,
        consolidation: "local-deterministic",
        batches: [result.rawOutput],
        splitCallCount: 1,
        modelInputTokenLimit: input.provider.maxInputTokens ?? 16_000,
        inputTokenLimitSource: input.provider.inputTokenLimitSource ?? "unknown_fallback",
        automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
        consolidatedKnowledgeBase: consolidation.knowledgeBase,
      }),
      splitCallCount: 1,
      modelInputTokenLimit: input.provider.maxInputTokens ?? 16_000,
      inputTokenLimitSource: input.provider.inputTokenLimitSource ?? "unknown_fallback",
      renderedPromptChars,
      automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
    };
  }

  // Extract batches with bounded concurrency, preserving batch order in partialResults.
  const partialResults: Awaited<ReturnType<typeof extractProjectKnowledgeBatch>>[] = [];
  for (let start = 0; start < jobs.length; start += KNOWLEDGE_BATCH_CONCURRENCY) {
    const chunk = jobs.slice(start, start + KNOWLEDGE_BATCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (job, offset) => {
        const result = await extractProjectKnowledgeBatch({
          scope: input.scope,
          provider: input.provider,
          workItems: job.workItems,
          relevantExistingKnowledge: job.relevantExistingKnowledge,
          mode: input.mode,
          batchIndex: start + offset + 1,
          batchCount: jobs.length,
        });
        await input.onBatchCompleted?.();
        return result;
      }),
    );
    partialResults.push(...chunkResults);
  }

  // Deterministic, Zod-validated merge — mirrors the manual/external save path
  // (prepareProjectKnowledgeManualSave). This avoids an unbounded LLM "re-emit the whole
  // knowledge base" call, whose output overflows the token cap and hard-fails the build.
  const consolidation = consolidateProjectKnowledgeBases(
    partialResults.map((result) => result.validatedOutput),
  );

  // A truncation warning from any batch applies to the whole extraction; dedupe identical messages.
  const aggregatedWarnings = [...new Set(partialResults.flatMap((result) => result.warnings ?? []))];

  return {
    provider: partialResults[0].provider,
    model: partialResults[0].model,
    validatedOutput: consolidation.knowledgeBase,
    tokenUsage: partialResults.every((result) => hasTokenUsage(result.tokenUsage))
      ? partialResults.reduce(
          (total, result) => addTokenUsage(total, result.tokenUsage),
          undefined as LLMResult["tokenUsage"],
        )
      : undefined,
    warnings: aggregatedWarnings.length ? aggregatedWarnings : undefined,
    rawOutput: JSON.stringify({
      mode: input.mode,
      consolidation: "local-deterministic",
      batches: partialResults.map((result) => result.rawOutput),
      splitCallCount: jobs.length,
      modelInputTokenLimit: input.provider.maxInputTokens ?? 16_000,
      inputTokenLimitSource: input.provider.inputTokenLimitSource ?? "unknown_fallback",
      automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
      consolidatedKnowledgeBase: consolidation.knowledgeBase,
    }),
    splitCallCount: jobs.length,
    modelInputTokenLimit: input.provider.maxInputTokens ?? 16_000,
    inputTokenLimitSource: input.provider.inputTokenLimitSource ?? "unknown_fallback",
    renderedPromptChars,
    automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
  };
}

async function extractProjectKnowledgeBatch(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  workItems: ProjectKnowledgeWorkItem[];
  relevantExistingKnowledge: ProjectKnowledgeBase;
  mode: ProjectKnowledgeCompileMode;
  batchIndex?: number;
  batchCount?: number;
}) {
  return input.provider.generateStructuredOutput({
    schemaName: "ProjectKnowledgeBase",
    schema: ProjectKnowledgeBaseSchema,
    system: projectKnowledgeExtractionPrompt.system,
    user: buildProjectKnowledgeExtractionUserPrompt({
      scope: input.scope,
      workItems: input.workItems,
      relevantExistingKnowledge: input.relevantExistingKnowledge,
      mode: input.mode,
      batchIndex: input.batchIndex,
      batchCount: input.batchCount,
    }),
    metadata: {
      action: "project_knowledge.extract",
      promptName: projectKnowledgeExtractionPrompt.name,
      promptVersion: projectKnowledgeExtractionPrompt.version,
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
      azureOrganizationUrl: input.scope.azureOrganizationUrl,
    },
  });
}

function buildProjectKnowledgeExtractionUserPrompt(input: {
  scope: ProjectScope;
  workItems: ProjectKnowledgeWorkItem[];
  relevantExistingKnowledge?: ProjectKnowledgeBase;
  mode: ProjectKnowledgeCompileMode;
  batchIndex?: number;
  batchCount?: number;
}) {
  return JSON.stringify({
    extractionMode: input.batchCount ? "batch" : input.mode,
    knowledgeCompileMode: input.mode,
    incrementalInstruction: input.mode === "incremental"
      ? "Reconcile every relevantExistingKnowledge entry against the changed source snapshots. Return still-supported, updated, and newly supported entries; omitted source-linked claims are retired deterministically."
      : undefined,
    batchIndex: input.batchIndex,
    batchCount: input.batchCount,
    workItems: input.workItems.map(toPromptWorkItem),
    relevantExistingKnowledge: input.relevantExistingKnowledge,
    projectScope: {
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
    },
  }, null, 2);
}

function buildProjectKnowledgeConsolidationUserPrompt(input: {
  scope: ProjectScope;
  partialKnowledgeBases: ProjectKnowledgeBase[];
}) {
  return JSON.stringify({
    partialKnowledgeBases: input.partialKnowledgeBases,
    projectScope: {
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
    },
  }, null, 2);
}

function loadProjectKnowledgeWorkItemsFromManifest(
  scope: ProjectScope,
  manifest: ProjectKnowledgeDraft["sourceManifest"],
): Promise<ProjectKnowledgeWorkItem[]> {
  ensureProjectContextSyncSchema();
  if (!manifest.length) return Promise.resolve([]);
  const snapshotIds = manifest.map((entry) => entry.sourceSnapshotId);
  const manifestOrder = new Map(snapshotIds.map((id, index) => [id, index]));
  return sqlAll<ProjectKnowledgeSnapshotWorkItemRow>(
    `
      SELECT id, azure_work_item_id, work_item_type, content_hash, fields_json, source_updated_at
      FROM azure_devops_work_item_snapshots
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND id = ANY(@snapshotIds::text[])
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      snapshotIds,
    },
  ).then((rows) => {
    const items = rows
      .sort((first, second) => (manifestOrder.get(first.id) ?? 0) - (manifestOrder.get(second.id) ?? 0))
      .map((row) => {
        const fields = snapshotFields(row.fields_json);
        const description = optionalStringField(fields.description);
        const acceptanceCriteria = optionalStringField(fields.acceptanceCriteria);
        return {
          id: row.azure_work_item_id,
          sourceSnapshotId: row.id,
          workItemType: row.work_item_type,
          title: stringField(fields.title),
          state: optionalStringField(fields.state),
          description: description ? stripHtml(description) : undefined,
          acceptanceCriteria: acceptanceCriteria ? stripHtml(acceptanceCriteria) : undefined,
          tags: snapshotTags(fields.tags),
          areaPath: optionalStringField(fields.areaPath),
          iterationPath: optionalStringField(fields.iterationPath),
          updatedDate: row.source_updated_at ?? undefined,
          contentHash: row.content_hash,
        };
      });
    if (items.length !== manifest.length) {
      const found = new Set(items.map((item) => item.sourceSnapshotId));
      const missing = snapshotIds.filter((id) => !found.has(id));
      throw new Error(`Draft source snapshots are missing: ${missing.join(", ")}`);
    }
    return items;
  });
}

function snapshotFields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalStringField(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function snapshotTags(value: unknown) {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === "string");
  return typeof value === "string" ? parseTags(value) : undefined;
}

function buildWorkItemBatches(workItems: ProjectKnowledgeWorkItem[]) {
  const batches: ProjectKnowledgeWorkItem[][] = [];
  let current: ProjectKnowledgeWorkItem[] = [];
  let currentChars = 0;

  workItems.forEach((item) => {
    const itemChars = JSON.stringify(item).length;
    if (current.length && currentChars + itemChars > MAX_CONTEXT_INPUT_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  });

  if (current.length) batches.push(current);
  return batches.length ? batches : [[]];
}

type ProjectKnowledgeExtractionJob = {
  workItems: ProjectKnowledgeWorkItem[];
  relevantExistingKnowledge: ProjectKnowledgeBase;
};

function buildProjectKnowledgeExtractionJobs(input: {
  scope: ProjectScope;
  workItems: ProjectKnowledgeWorkItem[];
  existingKnowledgeBase: ProjectKnowledgeBase | null;
  mode: ProjectKnowledgeCompileMode;
  maxInputTokens: number;
}) {
  const sourceBatches = buildWorkItemBatches(input.workItems);
  const jobs: ProjectKnowledgeExtractionJob[] = [];
  for (const workItems of sourceBatches) {
    const sourceIds = new Set(workItems.map((item) => item.id));
    const relevantEntries = input.existingKnowledgeBase
      ? flattenRawKnowledgeEntries(input.existingKnowledgeBase).filter((entry) =>
          entry.sourceWorkItemIds.some((sourceId) => sourceIds.has(sourceId)),
        )
      : [];
    const emptyKnowledge = emptyProjectKnowledgeBase();
    if (!relevantEntries.length) {
      assertKnowledgeExtractionJobFits({ ...input, workItems, relevantExistingKnowledge: emptyKnowledge });
      jobs.push({ workItems, relevantExistingKnowledge: emptyKnowledge });
      continue;
    }

    let currentEntries: ReturnType<typeof flattenRawKnowledgeEntries> = [];
    for (const entry of relevantEntries) {
      const candidateEntries = [...currentEntries, entry];
      const candidateKnowledge = knowledgeBaseFromRawEntries(candidateEntries);
      if (knowledgeExtractionJobFits({ ...input, workItems, relevantExistingKnowledge: candidateKnowledge })) {
        currentEntries = candidateEntries;
        continue;
      }
      if (!currentEntries.length) {
        throw new Error(
          `Exact source-linked knowledge entry ${entry.category}:${entry.entryKey} cannot fit the rendered ${input.maxInputTokens.toLocaleString()}-token input budget.`,
        );
      }
      jobs.push({
        workItems,
        relevantExistingKnowledge: knowledgeBaseFromRawEntries(currentEntries),
      });
      currentEntries = [entry];
      assertKnowledgeExtractionJobFits({
        ...input,
        workItems,
        relevantExistingKnowledge: knowledgeBaseFromRawEntries(currentEntries),
      });
    }
    if (currentEntries.length) {
      jobs.push({ workItems, relevantExistingKnowledge: knowledgeBaseFromRawEntries(currentEntries) });
    }
  }
  return jobs;
}

function knowledgeExtractionJobFits(input: {
  scope: ProjectScope;
  workItems: ProjectKnowledgeWorkItem[];
  relevantExistingKnowledge: ProjectKnowledgeBase;
  mode: ProjectKnowledgeCompileMode;
  maxInputTokens: number;
}) {
  const renderedChars = renderedKnowledgeJobChars(input);
  return Math.ceil(renderedChars / 4) <= Math.floor(input.maxInputTokens * 0.9);
}

function renderedKnowledgeJobChars(input: {
  scope: ProjectScope;
  workItems: ProjectKnowledgeWorkItem[];
  relevantExistingKnowledge: ProjectKnowledgeBase;
  mode: ProjectKnowledgeCompileMode;
  batchIndex?: number;
  batchCount?: number;
}) {
  const user = buildProjectKnowledgeExtractionUserPrompt({
    scope: input.scope,
    workItems: input.workItems,
    relevantExistingKnowledge: input.relevantExistingKnowledge,
    mode: input.mode,
    batchIndex: input.batchIndex,
    batchCount: input.batchCount,
  });
  return projectKnowledgeExtractionPrompt.system.length +
    user.length +
    JSON.stringify(PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE).length;
}

function assertKnowledgeExtractionJobFits(input: Parameters<typeof knowledgeExtractionJobFits>[0]) {
  if (knowledgeExtractionJobFits(input)) return;
  const sourceId = input.workItems[0]?.id ?? "unknown";
  throw new Error(
    `Source work item ${sourceId} cannot fit the rendered ${input.maxInputTokens.toLocaleString()}-token input budget.`,
  );
}

type RawKnowledgeEntry = {
  category: "modules" | "businessRules" | "stateTransitions" | "glossary" | "crossDependencies";
  entryKey: string;
  sourceWorkItemIds: string[];
  value: Record<string, unknown>;
};

function flattenRawKnowledgeEntries(knowledgeBase: ProjectKnowledgeBase): RawKnowledgeEntry[] {
  return [
    ...knowledgeBase.modules.map((value) => ({ category: "modules" as const, entryKey: value.id, sourceWorkItemIds: value.sourceWorkItemIds, value })),
    ...knowledgeBase.businessRules.map((value) => ({ category: "businessRules" as const, entryKey: value.id, sourceWorkItemIds: value.sourceWorkItemIds, value })),
    ...knowledgeBase.stateTransitions.map((value) => ({ category: "stateTransitions" as const, entryKey: value.id, sourceWorkItemIds: value.sourceWorkItemIds, value })),
    ...knowledgeBase.glossary.map((value) => ({ category: "glossary" as const, entryKey: value.term, sourceWorkItemIds: value.sourceWorkItemIds, value })),
    ...knowledgeBase.crossDependencies.map((value) => ({ category: "crossDependencies" as const, entryKey: value.id, sourceWorkItemIds: value.sourceWorkItemIds, value })),
  ];
}

function knowledgeBaseFromRawEntries(entries: RawKnowledgeEntry[]) {
  return ProjectKnowledgeBaseSchema.parse({
    modules: entries.filter((entry) => entry.category === "modules").map((entry) => entry.value),
    businessRules: entries.filter((entry) => entry.category === "businessRules").map((entry) => entry.value),
    stateTransitions: entries.filter((entry) => entry.category === "stateTransitions").map((entry) => entry.value),
    glossary: entries.filter((entry) => entry.category === "glossary").map((entry) => entry.value),
    crossDependencies: entries.filter((entry) => entry.category === "crossDependencies").map((entry) => entry.value),
  });
}

function emptyProjectKnowledgeBase() {
  return ProjectKnowledgeBaseSchema.parse({});
}

function toProjectKnowledgeSnapshot(row: ProjectKnowledgeSnapshotRow): ProjectKnowledgeSnapshot {
  const staleReasons = parseUnknownArray(row.stale_reason_json);
  const warnings = [
    row.freshness_status !== "current" ? "Published knowledge is stale; newer raw source evidence wins." : null,
    row.provenance_status !== "verified" ? "Knowledge provenance is not fully verified; retain raw source context." : null,
    row.compiler_compatibility !== "current" ? "Knowledge was compiled with an older compiler contract." : null,
  ].filter((warning): warning is string => Boolean(warning));
  const health: ProjectKnowledgeHealth = {
    freshness: row.freshness_status,
    provenance: row.provenance_status,
    compilerCompatibility: row.compiler_compatibility,
    staleSince: row.stale_since,
    staleReasons,
    timeToRefreshMs: row.stale_since ? Math.max(0, Date.now() - Date.parse(row.stale_since)) : null,
    rawContextRequired:
      row.freshness_status !== "current" ||
      row.provenance_status !== "verified" ||
      row.compiler_compatibility !== "current",
    trustedCompiledRetrieval:
      row.freshness_status === "current" &&
      row.provenance_status === "verified" &&
      row.compiler_compatibility === "current",
    warnings,
  };
  return {
    id: row.id,
    promptVersion: row.prompt_version,
    provider: row.provider,
    model: row.model_name,
    sourceWorkItemCount: row.source_work_item_count,
    rawOutput: row.raw_output,
    knowledgeBase: ProjectKnowledgeBaseSchema.parse(JSON.parse(row.validated_output)),
    status: row.status,
    errorDetails: row.error_details,
    extractedAt: row.extracted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeRevisionId: row.active_revision_id,
    sourceFingerprint: row.source_fingerprint,
    semanticHash: row.semantic_hash,
    provenanceHash: row.provenance_hash,
    compilerContractVersion: row.compiler_contract_version,
    health,
  };
}

export async function validateProjectKnowledgeManualBatch(input: {
  scope: ProjectScope;
  draftId: string;
  batchIndex: number;
  rawOutput: string;
}) {
  const knowledgeBase = validateProjectKnowledgeExternalOutput(input.rawOutput);
  await saveProjectKnowledgeManualBatchResult({
    ...input,
    validatedOutput: knowledgeBase,
  });
  return knowledgeBase;
}

function parseUnknownArray(value: unknown) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getKnowledgeCounts(knowledgeBase: ProjectKnowledgeBase) {
  return {
    modules: knowledgeBase.modules.length,
    businessRules: knowledgeBase.businessRules.length,
    stateTransitions: knowledgeBase.stateTransitions.length,
    glossary: knowledgeBase.glossary.length,
    crossDependencies: knowledgeBase.crossDependencies.length,
  };
}

function parseTags(value: string | null) {
  if (!value) return undefined;
  const tags = value
    .split(";")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length ? tags : undefined;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
