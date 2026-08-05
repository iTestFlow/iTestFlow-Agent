import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { parseExternalStructuredOutput } from "@/modules/llm/external-structured-output";
import type { LLMProvider, LLMResult } from "@/modules/llm/llm-types";
import { addTokenUsage, hasTokenUsage } from "@/modules/llm/token-usage";
import { buildManualPromptMarkdown } from "@/modules/llm/manual-prompt";
import { projectKnowledgeExtractionPrompt } from "@/modules/llm/prompts";
import { nowIso, sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import {
  ProjectKnowledgeBaseSchema,
  projectKnowledgeEvidenceRefSourceKey,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeChatInsight,
} from "./project-knowledge.schema";
import { CHAT_INSIGHT_CATEGORY } from "./context-chatbot-retrieval.service";
import {
  buildProjectKnowledgeCitationSources,
  buildProjectSourceDocumentCitationSources,
  generatedProjectKnowledgeForOmissions,
  groundGeneratedProjectKnowledge,
  PROJECT_KNOWLEDGE_GENERATED_OUTPUT_SHAPE,
  ProjectKnowledgeGeneratedBaseSchema,
  projectKnowledgeBaseToGeneratedPrompt,
  type ProjectKnowledgeGeneratedBase,
  type ProjectKnowledgeCitationSource,
  type ProjectKnowledgeGroundingOmission,
  type ProjectSourceDocumentCitationChunk,
} from "./project-knowledge-grounding";
import { projectKnowledgeCanonicalSourceText } from "./project-knowledge-source-text";
import {
  mergeProjectKnowledgeConflictEntries,
  type ProjectKnowledgeConsolidationCategory,
  type ProjectKnowledgeEntryByConsolidationCategory,
} from "./project-knowledge-consolidation";
import {
  carryOverProjectKnowledgeWording,
  isCompatibleProjectKnowledgeParaphrase,
  projectKnowledgeConsolidationCandidateKeys,
} from "./project-knowledge-wording-carryover";
import {
  PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
  isProjectKnowledgeDocumentSourceManifestEntry,
} from "./project-knowledge-contracts";
import { canonicalizeProjectKnowledgeDependencyType } from "./project-knowledge-dependency-type";
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
  loadLatestResumableProjectKnowledgeManualDraft,
  loadProjectKnowledgeManualBatchResults,
  setProjectKnowledgeDraftCompilationMode,
  storeProjectKnowledgeManualDraftBatches,
  saveProjectKnowledgeManualBatchResult,
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
  kind: "work_item";
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

type ProjectKnowledgeDocumentChunk = ProjectSourceDocumentCitationChunk & {
  kind: "document";
  contentHash?: string | null;
};

type ProjectKnowledgeCompilationSource = ProjectKnowledgeWorkItem | ProjectKnowledgeDocumentChunk;

type ProjectKnowledgeDocumentChunkRow = {
  id: string;
  document_id: string;
  source_document_version_id: string;
  document_name: string;
  document_type: string | null;
  section: string | null;
  page_number: number | null;
  chunk_index: number;
  content: string;
  metadata_json: unknown;
  content_hash: string;
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
  wordingCarryOverCount: number;
  omittedEntryCount: number;
  omissionReasons: Record<string, number>;
  citationRepairCallCount: number;
};

export async function previewGeneratedProjectKnowledgeBase(input: {
  scope: ProjectScope;
  actor: string;
  provider: LLMProvider;
  mode?: ProjectKnowledgeCompileMode;
  baseKnowledgeBase?: ProjectKnowledgeBase;
  signal?: AbortSignal;
  onProgress?: (progress: { phase: string; completed?: number; total?: number; draftId?: string }) => Promise<void>;
  existingDraftId?: string;
  preserveDraftOnError?: boolean;
  batchCache?: {
    load: (batchIndex: number) => Promise<unknown | null>;
    save: (batchIndex: number, result: Record<string, unknown>) => Promise<void>;
  };
}): Promise<ProjectKnowledgeGeneratedDraft> {
  const scope = assertProjectScope(input.scope);
  const startedAt = Date.now();
  const persistedDraft = input.existingDraftId
    ? await getProjectKnowledgeDraft({ scope, draftId: input.existingDraftId })
    : await beginProjectKnowledgeDraft({
        scope,
        actor: input.actor,
        generationMode: "automatic",
        compilationMode: input.mode ?? "incremental",
      });
  if (!persistedDraft || (input.existingDraftId && persistedDraft.persistedStatus !== "generating")) {
    throw new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "The resumable frozen draft is unavailable or no longer generating.",
      userMessage: "The background build can no longer resume this draft. Start a new build.",
    });
  }
  await input.onProgress?.({ phase: "loading_frozen_sources", draftId: persistedDraft.id });
  input.signal?.throwIfAborted();
  const sources = await loadProjectKnowledgeSourcesFromManifest(scope, persistedDraft.sourceManifest);
  if (!sources.length) {
    await failProjectKnowledgeDraft({ scope, draftId: persistedDraft.id, reason: "missing_source_snapshots" });
    throw new Error("Fetch and index project context before extracting the knowledge base.");
  }

  try {

  const selection = await selectProjectKnowledgeSourcesForCompilation({
    scope,
    sources,
    mode: input.mode ?? "incremental",
  });
  await input.onProgress?.({ phase: "preparing_frozen_build", draftId: persistedDraft.id });
  input.signal?.throwIfAborted();

  if (selection.mode === "incremental" && !selection.sources.length) {
    // This path does not re-extract source knowledge, so fresh duplicate twins
    // cannot form.
    const existingSnapshot = await getProjectKnowledgeBaseSnapshot({ scope });
    if (!existingSnapshot) throw new Error("Run a full knowledge recompile before incremental compilation.");

    const consolidation = selection.retiredSourceWorkItemIds.length
      ? mergeIncrementalProjectKnowledgeBase({
          existingKnowledgeBase: input.baseKnowledgeBase ?? existingSnapshot.knowledgeBase,
          partialKnowledgeBases: [],
          affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
          activeSourceIds: sources.map(projectKnowledgeSourceKey),
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
      sourceWorkItemCount: sources.length,
      promptedSourceWorkItemCount: selection.sources.length,
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
      wordingCarryOverCount: 0,
      omittedEntryCount: 0,
      omissionReasons: {},
      citationRepairCallCount: 0,
    };
    return completeGeneratedPreview({
      scope,
      draftId: persistedDraft.id,
      generated,
      sources,
      startedAt,
    });
  }

  const existingKnowledgeBase = input.baseKnowledgeBase ?? await getSavedProjectKnowledgeBase({ scope });
  const result = await extractProjectKnowledgeBase({
    scope,
    provider: input.provider,
    sources: selection.sources,
    mode: selection.mode,
    existingKnowledgeBase,
    signal: input.signal,
    batchCache: input.batchCache,
    onBatchCompleted: async (completed, total) => {
      await heartbeatProjectKnowledgeDraft({ scope, draftId: persistedDraft.id });
      await input.onProgress?.({
        phase: "compiling_batches",
        completed,
        total,
        draftId: persistedDraft.id,
      });
    },
  });
  const incrementalConsolidation = selection.mode === "incremental"
    ? mergeIncrementalProjectKnowledgeBase({
        existingKnowledgeBase: existingKnowledgeBase ?? await getRequiredExistingProjectKnowledgeBase(scope),
        partialKnowledgeBases: [result.validatedOutput],
        affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
        activeSourceIds: sources.map(projectKnowledgeSourceKey),
      })
    : null;
  const knowledgeBase = incrementalConsolidation?.knowledgeBase ?? result.validatedOutput;
  const automaticDuplicateConsolidationCount = result.automaticDuplicateConsolidationCount +
    (incrementalConsolidation?.automaticDuplicateConsolidationCount ?? 0);
  // Runs strictly after consolidation so a later chooseLongerText merge can never
  // overwrite restored wording. Covers full mode too: the previous KB is available
  // here even though full extraction otherwise replaces it wholesale.
  const carryOver = carryOverProjectKnowledgeWording({
    previousKnowledgeBase: existingKnowledgeBase ?? null,
    knowledgeBase,
  });

  const generated = {
    promptVersion: projectKnowledgeExtractionPrompt.version,
    provider: result.provider,
    model: result.model,
    requestedMode: selection.requestedMode,
    mode: selection.mode,
    fallbackReason: selection.fallbackReason,
    sourceWorkItemCount: sources.length,
    promptedSourceWorkItemCount: selection.sources.length,
    changedSourceWorkItemCount: selection.changedSourceWorkItemIds.length,
    changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
    retiredSourceWorkItemCount: selection.retiredSourceWorkItemIds.length,
    retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
    rawOutput: buildProjectKnowledgeGeneratedRawOutput({
      mode: selection.mode,
      resultRawOutput: result.rawOutput,
      changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
      retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
      automaticDuplicateConsolidationCount,
      wordingCarryOverCount: carryOver.wordingCarryOverCount,
    }),
    knowledgeBase: carryOver.knowledgeBase,
    generatedAt: nowIso(),
    warnings: result.warnings,
    tokenUsage: result.tokenUsage,
    splitCallCount: result.splitCallCount,
    modelInputTokenLimit: result.modelInputTokenLimit,
    inputTokenLimitSource: result.inputTokenLimitSource,
    renderedPromptChars: result.renderedPromptChars,
    automaticDuplicateConsolidationCount,
    wordingCarryOverCount: carryOver.wordingCarryOverCount,
    omittedEntryCount: result.omittedEntryCount,
    omissionReasons: result.omissionReasons,
    citationRepairCallCount: result.citationRepairCallCount,
  };
  await input.onProgress?.({ phase: "validating_citations", draftId: persistedDraft.id });
  input.signal?.throwIfAborted();
  return completeGeneratedPreview({
    scope,
    draftId: persistedDraft.id,
    generated,
    sources,
    startedAt,
  });
  } catch (error) {
    if (input.signal?.aborted || !input.preserveDraftOnError) {
      await failProjectKnowledgeDraft({
        scope,
        draftId: persistedDraft.id,
        reason: input.signal?.aborted
          ? "cancelled"
          : error instanceof Error ? error.message : "generation_failed",
      });
    }
    throw error;
  }
}

async function completeGeneratedPreview(input: {
  scope: ProjectScope;
  draftId: string;
  generated: Omit<ProjectKnowledgeGeneratedDraft, "draftId" | "draftStatus" | "blockers" | "reviewSummary">;
  sources: ProjectKnowledgeCompilationSource[];
  startedAt: number;
}): Promise<ProjectKnowledgeGeneratedDraft> {
  const sizeMetrics = buildProjectKnowledgeSizeMetrics(input.sources, input.generated.knowledgeBase);
  const touchedSourceIds = input.generated.mode === "full"
    ? projectKnowledgeSourceKeys(input.sources)
    : Array.from(new Set([
        ...input.generated.changedSourceWorkItemIds,
        ...input.generated.retiredSourceWorkItemIds,
      ]));
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
      wordingCarryOverCount: input.generated.wordingCarryOverCount,
      omittedEntryCount: input.generated.omittedEntryCount,
      omissionReasons: input.generated.omissionReasons,
      citationRepairCallCount: input.generated.citationRepairCallCount,
    },
    touchedSourceIds,
    // Preserve the established work-item-only completion seam for callers and
    // tests that still inspect it; document keys travel through touchedSourceIds.
    touchedSourceWorkItemIds: touchedSourceIds.filter((sourceId) => !sourceId.startsWith("document:")),
  });
  return {
    ...input.generated,
    draftId: completed.id,
    draftStatus: completed.status,
    blockers: completed.blockers,
    reviewSummary: completed.reviewSummary,
  };
}

function buildProjectKnowledgeGeneratedRawOutput(input: {
  mode: ProjectKnowledgeCompileMode;
  resultRawOutput: string;
  changedSourceWorkItemIds: string[];
  retiredSourceWorkItemIds: string[];
  automaticDuplicateConsolidationCount: number;
  wordingCarryOverCount: number;
}) {
  if (input.mode === "incremental") {
    return JSON.stringify({
      mode: "incremental",
      changedSourceWorkItemIds: input.changedSourceWorkItemIds,
      retiredSourceWorkItemIds: input.retiredSourceWorkItemIds,
      extraction: input.resultRawOutput,
      automaticDuplicateConsolidationCount: input.automaticDuplicateConsolidationCount,
      wordingCarryOverCount: input.wordingCarryOverCount,
    });
  }
  return input.resultRawOutput;
}

function buildProjectKnowledgeSizeMetrics(
  sources: ProjectKnowledgeCompilationSource[],
  knowledgeBase: ProjectKnowledgeBase,
) {
  const normalizedSourceChars = sources.reduce(
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

/**
 * Approved chat insights, read directly from `project_knowledge_entries` rather than
 * from the compiled snapshot. Kept out of `project_knowledge_base.validated_output` on
 * purpose: that column is wholesale replaced by every publish, and an insight has to
 * survive a knowledge republish precisely because it was never part of what the compiler
 * produced (see `indexApprovedChatInsight`'s doc comment). Merging it in here, at read
 * time, is what makes it visible to the workflow prompts that consume this function's
 * return value -- without this, `integrateProjectKnowledgeCandidate`'s own stated intent
 * ("so a saved chatbot answer can inform later answers and workflow prompts") only ever
 * held for the Business Owner Assistant, which reads project_knowledge_entries directly;
 * every workflow prompt builder reads only the compiled snapshot and never saw one.
 */
async function loadIntegratedChatInsights(scope: ProjectScope): Promise<ProjectKnowledgeChatInsight[]> {
  const rows = await sqlAll<{
    entry_key: string;
    title: string;
    content: string;
    source_work_item_ids: string;
    evidence: string;
  }>(
    `
      SELECT entry_key, title, content, source_work_item_ids, evidence
      FROM project_knowledge_entries
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND category = @category
      ORDER BY entry_key
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId, category: CHAT_INSIGHT_CATEGORY },
  );
  return rows.map((row) => ({
    id: row.entry_key,
    title: row.title,
    content: row.content,
    sourceWorkItemIds: row.source_work_item_ids
      ? row.source_work_item_ids.split(",").map((id) => id.trim()).filter(Boolean)
      : [],
    evidence: row.evidence,
  }));
}

export async function loadProjectKnowledgeContext(input: {
  scope: ProjectScope;
  consumer?: string;
}): Promise<ProjectKnowledgeConsumerContext> {
  const scope = assertProjectScope(input.scope);
  const chatInsights = await loadIntegratedChatInsights(scope);
  const snapshot = await getProjectKnowledgeBaseSnapshot(input);
  if (!snapshot) {
    return {
      knowledgeBase: chatInsights.length
        ? { modules: [], businessRules: [], stateTransitions: [], glossary: [], crossDependencies: [], chatInsights }
        : null,
      health: null,
      usage: "raw_only",
      promptNotice: null,
    };
  }
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
  return {
    knowledgeBase: { ...snapshot.knowledgeBase, chatInsights },
    health: snapshot.health,
    usage,
    promptNotice,
  };
}

export async function getSavedProjectKnowledgeBase(input: { scope: ProjectScope; consumer?: string }) {
  return (await loadProjectKnowledgeContext(input)).knowledgeBase;
}

export async function buildProjectKnowledgeManualDraft(input: {
  scope: ProjectScope;
  actor?: string;
  mode?: ProjectKnowledgeCompileMode;
}) {
  const scope = assertProjectScope(input.scope);
  const persistedDraft = await beginProjectKnowledgeDraft({
    scope,
    actor: input.actor ?? "system",
    generationMode: "manual",
    compilationMode: input.mode ?? "full",
  });
  const sources = await loadProjectKnowledgeSourcesFromManifest(scope, persistedDraft.sourceManifest);
  if (!sources.length) {
    throw new Error("Fetch and index project context before extracting the knowledge base.");
  }
  const selection = await selectProjectKnowledgeSourcesForCompilation({
    scope,
    sources,
    mode: input.mode ?? "full",
  });
  await setProjectKnowledgeDraftCompilationMode({
    scope,
    draftId: persistedDraft.id,
    compilationMode: selection.mode,
  });

  const existingKnowledgeBase = await getSavedProjectKnowledgeBase({ scope });
  const batches = selection.sources.length
    ? buildProjectKnowledgeExtractionJobs({
        scope,
        sources: selection.sources,
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
      sources: batch.sources,
      relevantExistingKnowledge: batch.relevantExistingKnowledge,
      mode: selection.mode,
      ...batchMetadata,
    });

    return {
      batchIndex,
      batchCount: batches.length,
      workItemCount: batch.sources.length,
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
    schemaName: "ProjectKnowledgeGeneratedBase",
    promptName: projectKnowledgeExtractionPrompt.name,
    promptVersion: projectKnowledgeExtractionPrompt.version,
    requestedMode: selection.requestedMode,
    mode: selection.mode,
    fallbackReason: selection.fallbackReason,
    sourceWorkItemCount: selection.sources.length,
    totalSourceWorkItemCount: sources.length,
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

/**
 * Reconstructs the client-facing prompt payload for the latest manual draft
 * still awaiting input. Prompts stay on the persisted batch records so a page
 * reload or temporary workspace-level disablement does not discard progress.
 */
export async function resumeLatestProjectKnowledgeManualDraft(input: {
  scope: ProjectScope;
}) {
  const scope = assertProjectScope(input.scope);
  const resumable = await loadLatestResumableProjectKnowledgeManualDraft({ scope });
  if (!resumable) return null;

  // Manual drafts are created only in these modes. Treat a legacy non-incremental
  // value as full so its stored prompts can still be resumed safely.
  const mode: ProjectKnowledgeCompileMode = resumable.draft.compilationMode === "incremental"
    ? "incremental"
    : "full";
  const batchCount = resumable.batches.length;

  return {
    draftId: resumable.draft.id,
    draftStatus: resumable.draft.status,
    schemaName: "ProjectKnowledgeGeneratedBase",
    promptName: projectKnowledgeExtractionPrompt.name,
    promptVersion: projectKnowledgeExtractionPrompt.version,
    mode,
    batchCount,
    batches: resumable.batches.map((batch) => ({
      batchIndex: batch.batchIndex,
      batchCount,
      prompt: buildManualPromptMarkdown({
        title: buildManualKnowledgePromptTitle(mode, batch.batchIndex, batchCount),
        system: batch.systemPrompt,
        user: batch.userPrompt,
      }),
    })),
    validatedBatchIndexes: resumable.validatedBatchIndexes,
  };
}

export function validateProjectKnowledgeGeneratedExternalOutput(rawOutput: string) {
  return parseExternalStructuredOutput({
    schemaName: "ProjectKnowledgeGeneratedBase",
    schema: ProjectKnowledgeGeneratedBaseSchema,
    rawOutput,
  });
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
  const sources = await loadProjectKnowledgeSourcesFromManifest(scope, draft.sourceManifest);
  if (!sources.length) {
    throw new Error("Fetch and index project context before saving the knowledge base.");
  }
  if (!partialKnowledgeBases.length && (input.mode ?? "full") !== "incremental") {
    throw new Error("Validate at least one batch response before saving the knowledge base.");
  }

  const saveResult = await prepareProjectKnowledgeManualSave({
    scope,
    sources,
    partialKnowledgeBases,
    mode: input.mode ?? "full",
  });
  const rawOutput = JSON.stringify({
    consolidationMode: "local-deterministic",
    mode: saveResult.mode,
    changedSourceWorkItemIds: saveResult.changedSourceWorkItemIds,
    retiredSourceWorkItemIds: saveResult.retiredSourceWorkItemIds,
    automaticDuplicateConsolidationCount: saveResult.automaticDuplicateConsolidationCount,
    wordingCarryOverCount: saveResult.wordingCarryOverCount,
    partialKnowledgeBases,
    consolidatedKnowledgeBase: saveResult.knowledgeBase,
  });
  const touchedSourceIds = saveResult.mode === "full"
    ? projectKnowledgeSourceKeys(sources)
    : Array.from(new Set([...saveResult.changedSourceWorkItemIds, ...saveResult.retiredSourceWorkItemIds]));
  const completed = await completeProjectKnowledgeDraft({
    scope,
    draftId,
    provider: "external",
    model: "manual-external",
    rawOutput,
    knowledgeBase: saveResult.knowledgeBase,
    metrics: {
      ...buildProjectKnowledgeSizeMetrics(sources, saveResult.knowledgeBase),
      splitCallCount: partialKnowledgeBases.length,
      renderedPromptChars: persistedBatches?.renderedPromptChars ?? 0,
      automaticDuplicateConsolidationCount: saveResult.automaticDuplicateConsolidationCount,
      wordingCarryOverCount: saveResult.wordingCarryOverCount,
    },
    touchedSourceIds,
    touchedSourceWorkItemIds: touchedSourceIds.filter((sourceId) => !sourceId.startsWith("document:")),
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
      sourceWorkItemCount: sources.length,
      promptedSourceWorkItemCount: saveResult.promptedSourceWorkItemCount,
      changedSourceWorkItemIds: saveResult.changedSourceWorkItemIds,
      retiredSourceWorkItemIds: saveResult.retiredSourceWorkItemIds,
      batchCount: partialKnowledgeBases.length,
      counts: getKnowledgeCounts(saveResult.knowledgeBase),
      automaticDuplicateConsolidationCount: saveResult.automaticDuplicateConsolidationCount,
      wordingCarryOverCount: saveResult.wordingCarryOverCount,
    },
  });

  if (!completed.knowledgeBase) throw new Error("Manual draft completed without proposed knowledge.");
  return { ...completed, knowledgeBase: completed.knowledgeBase };
}

type ProjectKnowledgeSourceSelection = {
  requestedMode: ProjectKnowledgeCompileMode;
  mode: ProjectKnowledgeCompileMode;
  fallbackReason?: string;
  sources: ProjectKnowledgeCompilationSource[];
  changedSourceWorkItemIds: string[];
  retiredSourceWorkItemIds: string[];
  affectedSourceWorkItemIds: string[];
};

async function selectProjectKnowledgeSourcesForCompilation(input: {
  scope: ProjectScope;
  sources: ProjectKnowledgeCompilationSource[];
  mode: ProjectKnowledgeCompileMode;
}): Promise<ProjectKnowledgeSourceSelection> {
  if (input.mode === "full") {
    return {
      requestedMode: input.mode,
      mode: "full",
      sources: input.sources,
      changedSourceWorkItemIds: projectKnowledgeSourceKeys(input.sources),
      retiredSourceWorkItemIds: [],
      affectedSourceWorkItemIds: projectKnowledgeSourceKeys(input.sources),
    };
  }

  const existingSnapshot = await getProjectKnowledgeBaseSnapshot({ scope: input.scope });
  if (!existingSnapshot) {
    return {
      requestedMode: input.mode,
      mode: "full",
      fallbackReason: "No saved knowledge base exists yet, so the first compile must include every active work item and document source.",
      sources: input.sources,
      changedSourceWorkItemIds: projectKnowledgeSourceKeys(input.sources),
      retiredSourceWorkItemIds: [],
      affectedSourceWorkItemIds: projectKnowledgeSourceKeys(input.sources),
    };
  }

  if (existingSnapshot.compilerContractVersion !== PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION) {
    return {
      requestedMode: input.mode,
      mode: "full",
      fallbackReason: "The compiler contract changed, so every active source must be grounded with immutable citation handles.",
      sources: input.sources,
      changedSourceWorkItemIds: projectKnowledgeSourceKeys(input.sources),
      retiredSourceWorkItemIds: [],
      affectedSourceWorkItemIds: projectKnowledgeSourceKeys(input.sources),
    };
  }

  const previousSourceHashes = await loadLatestProjectKnowledgeSourceHashes(input.scope);
  if (!previousSourceHashes) {
    return selectProjectKnowledgeSourcesFromSnapshotTimestamp({
      requestedMode: input.mode,
      existingSnapshot,
      sources: input.sources,
    });
  }

  const currentSourceHashes = buildProjectKnowledgeSourceHashMap(input.sources);
  const changedSourceWorkItemIds = Array.from(new Set(input.sources
    .filter((source) => {
      const key = projectKnowledgeSourceKey(source);
      return previousSourceHashes[key] !== currentSourceHashes[key];
    })
    .map(projectKnowledgeSourceKey)));
  const currentSourceIds = new Set(input.sources.map(projectKnowledgeSourceKey));
  const retiredSourceWorkItemIds = Object.keys(previousSourceHashes).filter((sourceId) => !currentSourceIds.has(sourceId));
  const affectedSourceWorkItemIds = Array.from(new Set([...changedSourceWorkItemIds, ...retiredSourceWorkItemIds]));

  return {
    requestedMode: input.mode,
    mode: "incremental",
    sources: input.sources.filter((source) => changedSourceWorkItemIds.includes(projectKnowledgeSourceKey(source))),
    changedSourceWorkItemIds,
    retiredSourceWorkItemIds,
    affectedSourceWorkItemIds,
  };
}

function selectProjectKnowledgeSourcesFromSnapshotTimestamp(input: {
  requestedMode: ProjectKnowledgeCompileMode;
  existingSnapshot: ProjectKnowledgeSnapshot;
  sources: ProjectKnowledgeCompilationSource[];
}): ProjectKnowledgeSourceSelection {
  const extractedAtMs = Date.parse(input.existingSnapshot.extractedAt);
  const knownSourceIds = new Set(getKnowledgeSourceIds(input.existingSnapshot.knowledgeBase));
  const changedSourceWorkItemIds = Array.from(new Set(input.sources
    .filter((source) => {
      const sourceKey = projectKnowledgeSourceKey(source);
      // Never cited as a source in the existing knowledge base -- always changed,
      // regardless of its Azure DevOps updatedDate. Otherwise a work item that's
      // simply old and untouched but newly in scope (e.g. after widening a fetch
      // limit or filter) would look "unchanged" purely because its updatedDate
      // predates the last extraction, even though it has never actually been
      // compiled into knowledge at all.
      if (!knownSourceIds.has(sourceKey)) return true;
      // Historical revisions without source hashes have no trustworthy document
      // change timestamp. Recompile their frozen chunks conservatively.
      if (source.kind === "document") return true;
      if (!Number.isFinite(extractedAtMs)) return false;
      const updatedAtMs = Date.parse(source.updatedDate ?? "");
      return Number.isFinite(updatedAtMs) && updatedAtMs > extractedAtMs;
    })
    .map(projectKnowledgeSourceKey)));
  const activeSourceIds = new Set(input.sources.map(projectKnowledgeSourceKey));
  const retiredSourceWorkItemIds = Array.from(knownSourceIds).filter((sourceId) => !activeSourceIds.has(sourceId));
  const affectedSourceWorkItemIds = Array.from(new Set([...changedSourceWorkItemIds, ...retiredSourceWorkItemIds]));

  return {
    requestedMode: input.requestedMode,
    mode: "incremental",
    fallbackReason: "The saved knowledge revision does not include source hashes yet, so Compile Prompt used the saved extraction time as its baseline. Save the no-prompt baseline once to enable exact hash-based incremental prompts.",
    sources: input.sources.filter((source) => changedSourceWorkItemIds.includes(projectKnowledgeSourceKey(source))),
    changedSourceWorkItemIds,
    retiredSourceWorkItemIds,
    affectedSourceWorkItemIds,
  };
}

async function prepareProjectKnowledgeManualSave(input: {
  scope: ProjectScope;
  sources: ProjectKnowledgeCompilationSource[];
  partialKnowledgeBases: ProjectKnowledgeBase[];
  rawOutput?: string;
  mode: ProjectKnowledgeCompileMode;
}) {
  const selection = await selectProjectKnowledgeSourcesForCompilation({
    scope: input.scope,
    sources: input.sources,
    mode: input.mode,
  });
  const mode: ProjectKnowledgeCompileMode = input.mode === "incremental" && selection.mode === "incremental" ? "incremental" : "full";
  if (!input.partialKnowledgeBases.length && mode !== "incremental") {
    throw new Error("Validate at least one batch response before saving the knowledge base.");
  }

  const existingKnowledgeBase = mode === "incremental"
    ? await getRequiredExistingProjectKnowledgeBase(input.scope)
    : (await getProjectKnowledgeBaseSnapshot({ scope: input.scope }))?.knowledgeBase ?? null;
  const consolidation = mode === "incremental" && existingKnowledgeBase
    ? mergeIncrementalProjectKnowledgeBase({
        existingKnowledgeBase,
        partialKnowledgeBases: input.partialKnowledgeBases,
        affectedSourceWorkItemIds: selection.affectedSourceWorkItemIds,
        activeSourceIds: input.sources.map(projectKnowledgeSourceKey),
      })
    : consolidateProjectKnowledgeBases(input.partialKnowledgeBases);
  const carryOver = carryOverProjectKnowledgeWording({
    previousKnowledgeBase: existingKnowledgeBase,
    knowledgeBase: consolidation.knowledgeBase,
  });
  const knowledgeBase = carryOver.knowledgeBase;
  const sourceChangeSummary = buildCompilationSourceChangeSummary({
    knowledgeBase,
    sources: input.sources,
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
          wordingCarryOverCount: carryOver.wordingCarryOverCount,
          externalOutput: input.rawOutput,
          partialKnowledgeBases: input.partialKnowledgeBases,
          consolidatedKnowledgeBase: knowledgeBase,
        })
      : input.rawOutput ?? JSON.stringify({
          mode,
          automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
          wordingCarryOverCount: carryOver.wordingCarryOverCount,
          partialKnowledgeBases: input.partialKnowledgeBases,
          consolidatedKnowledgeBase: knowledgeBase,
        }),
    sourceChangeSummary,
    promptedSourceWorkItemCount: mode === "incremental" ? selection.sources.length : input.sources.length,
    changedSourceWorkItemIds: selection.changedSourceWorkItemIds,
    retiredSourceWorkItemIds: selection.retiredSourceWorkItemIds,
    automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
    wordingCarryOverCount: carryOver.wordingCarryOverCount,
  };
}

function mergeIncrementalProjectKnowledgeBase(input: {
  existingKnowledgeBase: ProjectKnowledgeBase;
  partialKnowledgeBases: ProjectKnowledgeBase[];
  affectedSourceWorkItemIds: string[];
  activeSourceIds: string[];
}) {
  const affectedSourceIds = new Set(input.affectedSourceWorkItemIds);
  const activeSourceIds = new Set(input.activeSourceIds);
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
      const refs = item.evidenceRefs ?? [];
      if (refs.length) {
        const retainedRefs = refs.filter((ref) => {
          const sourceKey = projectKnowledgeEvidenceRefSourceKey(ref);
          return Boolean(sourceKey) && activeSourceIds.has(sourceKey) && !affectedSourceIds.has(sourceKey);
        });
        if (retainedRefs.length === refs.length) return item;
        if (!retainedRefs.length) return null;
        return {
          ...item,
          sourceWorkItemIds: Array.from(new Set(retainedRefs.flatMap((ref) =>
            ref.sourceKind === "document" || !ref.sourceWorkItemId ? [] : [ref.sourceWorkItemId]))),
          evidenceRefs: retainedRefs,
        } as TItem;
      }
      const sourceWorkItemIds = item.sourceWorkItemIds.filter((sourceId) => activeSourceIds.has(sourceId) && !affectedSourceIds.has(sourceId));
      if (sourceWorkItemIds.length === item.sourceWorkItemIds.length) return item;
      if (!sourceWorkItemIds.length) return null;
      return {
        ...item,
        sourceWorkItemIds,
        evidenceRefs: item.evidenceRefs?.filter((ref) =>
          ref.sourceKind !== "document" &&
          typeof ref.sourceWorkItemId === "string" &&
          sourceWorkItemIds.includes(ref.sourceWorkItemId)),
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
  sources: ProjectKnowledgeCompilationSource[];
  selection?: Partial<ProjectKnowledgeSourceSelection>;
}) {
  const knowledgeCounts = getKnowledgeCounts(input.knowledgeBase);
  const workItems = input.sources.filter(isProjectKnowledgeWorkItem);
  const documentChunks = input.sources.filter(isProjectKnowledgeDocumentChunk);
  return {
    ...knowledgeCounts,
    knowledgeCounts,
    sourceWorkItemIds: workItems.map((item) => item.id),
    sourceWorkItemHashes: buildSourceWorkItemHashMap(workItems),
    sourceDocumentIds: Array.from(new Set(documentChunks.map((source) => source.sourceDocumentId))).sort(),
    sourceDocumentVersionIds: Array.from(new Set(documentChunks.map((source) => source.sourceDocumentVersionId))).sort(),
    sourceDocumentHashes: buildSourceDocumentHashMap(documentChunks),
    totalSourceWorkItemCount: input.sources.length,
    requestedMode: input.selection?.requestedMode,
    mode: input.selection?.mode,
    fallbackReason: input.selection?.fallbackReason,
    promptedSourceWorkItemCount: input.selection?.sources?.length ?? input.sources.length,
    changedSourceWorkItemIds: input.selection?.changedSourceWorkItemIds ?? [],
    retiredSourceWorkItemIds: input.selection?.retiredSourceWorkItemIds ?? [],
  };
}

function buildSourceWorkItemHashMap(workItems: ProjectKnowledgeWorkItem[]): ProjectKnowledgeSourceHashMap {
  return Object.fromEntries(workItems.map((item) => [item.id, item.contentHash ?? null]));
}

function buildSourceDocumentHashMap(sources: ProjectKnowledgeDocumentChunk[]): ProjectKnowledgeSourceHashMap {
  return Object.fromEntries(sources.map((source) => [
    `document:${source.sourceDocumentId}`,
    source.contentHash ?? null,
  ]));
}

function buildProjectKnowledgeSourceHashMap(sources: ProjectKnowledgeCompilationSource[]): ProjectKnowledgeSourceHashMap {
  return {
    ...buildSourceWorkItemHashMap(sources.filter(isProjectKnowledgeWorkItem)),
    ...buildSourceDocumentHashMap(sources.filter(isProjectKnowledgeDocumentChunk)),
  };
}

function getKnowledgeSourceIds(knowledgeBase: ProjectKnowledgeBase) {
  return Array.from(new Set([
    ...knowledgeBase.modules.flatMap(projectKnowledgeEntrySourceIds),
    ...knowledgeBase.businessRules.flatMap(projectKnowledgeEntrySourceIds),
    ...knowledgeBase.stateTransitions.flatMap(projectKnowledgeEntrySourceIds),
    ...knowledgeBase.glossary.flatMap(projectKnowledgeEntrySourceIds),
    ...knowledgeBase.crossDependencies.flatMap(projectKnowledgeEntrySourceIds),
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
    const parsed = JSON.parse(row.source_change_summary_json) as {
      sourceWorkItemHashes?: unknown;
      sourceDocumentHashes?: unknown;
    };
    const hashes: ProjectKnowledgeSourceHashMap = {};
    for (const sourceHashes of [parsed.sourceWorkItemHashes, parsed.sourceDocumentHashes]) {
      if (!sourceHashes || Array.isArray(sourceHashes) || typeof sourceHashes !== "object") continue;
      Object.entries(sourceHashes as Record<string, unknown>).forEach(([sourceId, hash]) => {
        if (typeof hash === "string" || hash === null) hashes[sourceId] = hash;
      });
    }
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

function isProjectKnowledgeWorkItem(
  source: ProjectKnowledgeCompilationSource,
): source is ProjectKnowledgeWorkItem {
  return source.kind === "work_item";
}

function isProjectKnowledgeDocumentChunk(
  source: ProjectKnowledgeCompilationSource,
): source is ProjectKnowledgeDocumentChunk {
  return source.kind === "document";
}

function projectKnowledgeSourceKey(source: ProjectKnowledgeCompilationSource) {
  return source.kind === "document" ? `document:${source.sourceDocumentId}` : source.id;
}

function projectKnowledgeSourceKeys(sources: ProjectKnowledgeCompilationSource[]) {
  return Array.from(new Set(sources.map(projectKnowledgeSourceKey)));
}

function projectKnowledgeEntrySourceIds(entry: {
  sourceWorkItemIds: string[];
  evidenceRefs?: ProjectKnowledgeBase["modules"][number]["evidenceRefs"];
}) {
  const refs = entry.evidenceRefs ?? [];
  return refs.length
    ? refs.map(projectKnowledgeEvidenceRefSourceKey).filter(Boolean)
    : entry.sourceWorkItemIds;
}

function buildProjectKnowledgeCitationSourcesForSources(
  sources: ProjectKnowledgeCompilationSource[],
): ProjectKnowledgeCitationSource[] {
  return sources.reduce<ProjectKnowledgeCitationSource[]>((citationSources, source) => {
    citationSources.push(...(source.kind === "document"
      ? buildProjectSourceDocumentCitationSources([source])
      : buildProjectKnowledgeCitationSources([source])));
    return citationSources;
  }, []);
}

function toPromptSource(source: ProjectKnowledgeCompilationSource, index: number) {
  const citationSources = buildProjectKnowledgeCitationSourcesForSources([source]);
  return {
    sourceGroup: `source_${index + 1}`,
    ...(source.kind === "document"
      ? {
          sourceKind: "document" as const,
          documentName: source.documentName,
          documentType: source.documentType,
          sourceDocumentId: source.sourceDocumentId,
          sourceDocumentVersionId: source.sourceDocumentVersionId,
        }
      : { workItemType: source.workItemType }),
    citationSources: citationSources.map(({ handle, sourceField, text }) => ({
      handle,
      sourceField,
      text,
    })),
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
    (item) => projectKnowledgeConsolidationCandidateKeys("module", item),
  );
  const businessRules = consolidateCategoryItems(
    "business_rule",
    partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.businessRules),
    (item) => projectKnowledgeConsolidationCandidateKeys("business_rule", item),
  );
  const stateTransitions = consolidateCategoryItems(
    "state_transition",
    partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.stateTransitions),
    (item) => projectKnowledgeConsolidationCandidateKeys("state_transition", item),
  );
  const glossary = consolidateCategoryItems(
    "glossary",
    partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.glossary),
    (item) => projectKnowledgeConsolidationCandidateKeys("glossary", item),
  );
  const crossDependencies = consolidateCategoryItems(
    "dependency",
    partialKnowledgeBases.flatMap((knowledgeBase) => knowledgeBase.crossDependencies),
    (item) => projectKnowledgeConsolidationCandidateKeys("dependency", item),
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
  const consolidatedItems = Array.from(groups.values()).flatMap((entries) => {
    const compatibleGroups = category === "dependency" || category === "business_rule"
      ? partitionCompatibleCategoryEntries(
        category,
        entries as ProjectKnowledgeEntryByConsolidationCategory["dependency" | "business_rule"][],
      )
      : [entries];
    return compatibleGroups.map((group) =>
      mergeProjectKnowledgeConflictEntries(category, group as ProjectKnowledgeEntryByConsolidationCategory[TCategory][]),
    );
  });

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
  return isCompatibleProjectKnowledgeParaphrase(category, first, second);
}

/**
 * Pairwise gate compatibility is not transitive: `dependency` can match both API
 * and event entries even though API and event cannot merge with one another, and
 * a business rule whose extraction abstains can match two constrained variants
 * (fingerprint or evidence equivalence) that provably disagree with each other.
 * The initial candidate-key union intentionally discovers this whole
 * neighborhood; before reducing it to one entry, split it into all-compatible
 * groups so a bridging entry cannot bury a real disagreement.
 *
 * Dependencies cluster over a canonical sort for cross-permutation determinism.
 * Business rules deliberately cluster in input order instead: the fully
 * compatible (overwhelmingly common) case must keep producing the same merge
 * winner as the pre-partition code path, or published ids would churn.
 */
function partitionCompatibleCategoryEntries<TCategory extends "business_rule" | "dependency">(
  category: TCategory,
  entries: ProjectKnowledgeEntryByConsolidationCategory[TCategory][],
) {
  const groups: ProjectKnowledgeEntryByConsolidationCategory[TCategory][][] = [];
  const orderedEntries = category === "dependency"
    ? [...entries].sort((first, second) => compareDependencyConsolidationEntries(
      first as ProjectKnowledgeEntryByConsolidationCategory["dependency"],
      second as ProjectKnowledgeEntryByConsolidationCategory["dependency"],
    ))
    : entries;

  orderedEntries.forEach((entry) => {
    const compatibleGroup = groups.find((group) =>
      group.every((existing) => isCompatibleProjectKnowledgeParaphrase(category, existing, entry)));
    if (compatibleGroup) {
      compatibleGroup.push(entry);
    } else {
      groups.push([entry]);
    }
  });

  return groups;
}

function compareDependencyConsolidationEntries(
  first: ProjectKnowledgeEntryByConsolidationCategory["dependency"],
  second: ProjectKnowledgeEntryByConsolidationCategory["dependency"],
) {
  return compareConsolidationText(
    canonicalizeProjectKnowledgeDependencyType(first.dependencyType),
    canonicalizeProjectKnowledgeDependencyType(second.dependencyType),
  ) ||
    compareConsolidationText(first.sourceModule, second.sourceModule) ||
    compareConsolidationText(first.targetModule, second.targetModule) ||
    compareConsolidationText(first.id, second.id) ||
    compareConsolidationText(first.description, second.description) ||
    compareConsolidationText(JSON.stringify(first), JSON.stringify(second));
}

function compareConsolidationText(first: string, second: string) {
  const firstCanonical = first.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  const secondCanonical = second.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  if (firstCanonical !== secondCanonical) return firstCanonical < secondCanonical ? -1 : 1;
  return first < second ? -1 : first > second ? 1 : 0;
}

async function extractProjectKnowledgeBase(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  sources: ProjectKnowledgeCompilationSource[];
  mode: ProjectKnowledgeCompileMode;
  existingKnowledgeBase: ProjectKnowledgeBase | null;
  signal?: AbortSignal;
  onBatchCompleted?: (completed: number, total: number) => Promise<void>;
  batchCache?: {
    load: (batchIndex: number) => Promise<unknown | null>;
    save: (batchIndex: number, result: Record<string, unknown>) => Promise<void>;
  };
}): Promise<LLMResult<ProjectKnowledgeBase> & {
  splitCallCount: number;
  modelInputTokenLimit: number;
  inputTokenLimitSource: string;
  renderedPromptChars: number;
  automaticDuplicateConsolidationCount: number;
  omittedEntryCount: number;
  omissionReasons: Record<string, number>;
  citationRepairCallCount: number;
}> {
  const jobs = buildProjectKnowledgeExtractionJobs({
    scope: input.scope,
    sources: input.sources,
    existingKnowledgeBase: input.existingKnowledgeBase,
    mode: input.mode,
    maxInputTokens: input.provider.maxInputTokens ?? 16_000,
  });
  const renderedPromptChars = jobs.reduce((total, job, index) => total + renderedKnowledgeJobChars({
    scope: input.scope,
    sources: job.sources,
    relevantExistingKnowledge: job.relevantExistingKnowledge,
    mode: input.mode,
    batchIndex: jobs.length > 1 ? index + 1 : undefined,
    batchCount: jobs.length > 1 ? jobs.length : undefined,
  }), 0);
  if (jobs.length === 1) {
    const result = await loadOrExtractProjectKnowledgeBatch({
      input,
      job: jobs[0],
      batchIndex: 1,
      batchCount: 1,
    });
    await input.onBatchCompleted?.(1, 1);
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
        automaticDuplicateConsolidationCount:
          result.automaticDuplicateConsolidationCount + consolidation.automaticDuplicateConsolidationCount,
        consolidatedKnowledgeBase: consolidation.knowledgeBase,
      }),
      splitCallCount: 1,
      modelInputTokenLimit: input.provider.maxInputTokens ?? 16_000,
      inputTokenLimitSource: input.provider.inputTokenLimitSource ?? "unknown_fallback",
      renderedPromptChars,
      automaticDuplicateConsolidationCount:
        result.automaticDuplicateConsolidationCount + consolidation.automaticDuplicateConsolidationCount,
      omittedEntryCount: result.omittedEntryCount,
      omissionReasons: result.omissionReasons,
      citationRepairCallCount: result.citationRepairCallCount,
    };
  }

  // Extract batches with bounded concurrency, preserving batch order in partialResults.
  const partialResults: Awaited<ReturnType<typeof extractProjectKnowledgeBatch>>[] = [];
  for (let start = 0; start < jobs.length; start += KNOWLEDGE_BATCH_CONCURRENCY) {
    const chunk = jobs.slice(start, start + KNOWLEDGE_BATCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (job, offset) => {
        const result = await loadOrExtractProjectKnowledgeBatch({
          input,
          job,
          batchIndex: start + offset + 1,
          batchCount: jobs.length,
        });
        await input.onBatchCompleted?.(start + offset + 1, jobs.length);
        return result;
      }),
    );
    partialResults.push(...chunkResults);
  }

  // Deterministic, Zod-validated merge â€” mirrors the manual/external save path
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
      automaticDuplicateConsolidationCount:
        partialResults.reduce((total, result) => total + result.automaticDuplicateConsolidationCount, 0) +
        consolidation.automaticDuplicateConsolidationCount,
      consolidatedKnowledgeBase: consolidation.knowledgeBase,
    }),
    splitCallCount: jobs.length,
    modelInputTokenLimit: input.provider.maxInputTokens ?? 16_000,
    inputTokenLimitSource: input.provider.inputTokenLimitSource ?? "unknown_fallback",
    renderedPromptChars,
    automaticDuplicateConsolidationCount:
      partialResults.reduce((total, result) => total + result.automaticDuplicateConsolidationCount, 0) +
      consolidation.automaticDuplicateConsolidationCount,
    omittedEntryCount: partialResults.reduce((total, result) => total + result.omittedEntryCount, 0),
    omissionReasons: mergeCountMaps(partialResults.map((result) => result.omissionReasons)),
    citationRepairCallCount: partialResults.reduce((total, result) => total + result.citationRepairCallCount, 0),
  };
}

type ProjectKnowledgeExtractionBatchResult = LLMResult<ProjectKnowledgeBase> & {
  automaticDuplicateConsolidationCount: number;
  omittedEntryCount: number;
  omissionReasons: Record<string, number>;
  citationRepairCallCount: number;
};

async function loadOrExtractProjectKnowledgeBatch(input: {
  input: {
    scope: ProjectScope;
    provider: LLMProvider;
    mode: ProjectKnowledgeCompileMode;
    signal?: AbortSignal;
    batchCache?: {
      load: (batchIndex: number) => Promise<unknown | null>;
      save: (batchIndex: number, result: Record<string, unknown>) => Promise<void>;
    };
  };
  job: ProjectKnowledgeExtractionJob;
  batchIndex: number;
  batchCount: number;
}) {
  const cached = parseCachedProjectKnowledgeBatch(
    await input.input.batchCache?.load(input.batchIndex),
  );
  if (cached) return cached;
  input.input.signal?.throwIfAborted();
  const result = await extractProjectKnowledgeBatch({
    scope: input.input.scope,
    provider: input.input.provider,
    sources: input.job.sources,
    relevantExistingKnowledge: input.job.relevantExistingKnowledge,
    mode: input.input.mode,
    batchIndex: input.batchCount > 1 ? input.batchIndex : undefined,
    batchCount: input.batchCount > 1 ? input.batchCount : undefined,
    signal: input.input.signal,
  });
  await input.input.batchCache?.save(
    input.batchIndex,
    JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
  );
  return result;
}

function parseCachedProjectKnowledgeBatch(value: unknown): ProjectKnowledgeExtractionBatchResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const validated = ProjectKnowledgeBaseSchema.safeParse(record.validatedOutput);
  if (!validated.success) return null;
  if (!["openai", "gemini", "anthropic"].includes(String(record.provider))) return null;
  if (typeof record.model !== "string" || typeof record.rawOutput !== "string") return null;
  const omissionReasons = record.omissionReasons && typeof record.omissionReasons === "object" && !Array.isArray(record.omissionReasons)
    ? Object.fromEntries(Object.entries(record.omissionReasons as Record<string, unknown>)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number"))
    : {};
  const tokenUsage = record.tokenUsage && typeof record.tokenUsage === "object" && !Array.isArray(record.tokenUsage)
    ? record.tokenUsage as LLMResult["tokenUsage"]
    : undefined;
  return {
    provider: record.provider as LLMResult["provider"],
    model: record.model,
    rawOutput: record.rawOutput,
    validatedOutput: validated.data,
    tokenUsage,
    warnings: Array.isArray(record.warnings)
      ? record.warnings.filter((warning): warning is string => typeof warning === "string")
      : undefined,
    omittedEntryCount: typeof record.omittedEntryCount === "number" ? record.omittedEntryCount : 0,
    omissionReasons,
    citationRepairCallCount: typeof record.citationRepairCallCount === "number" ? record.citationRepairCallCount : 0,
    automaticDuplicateConsolidationCount: typeof record.automaticDuplicateConsolidationCount === "number"
      ? record.automaticDuplicateConsolidationCount
      : 0,
  };
}

async function extractProjectKnowledgeBatch(input: {
  scope: ProjectScope;
  provider: LLMProvider;
  sources: ProjectKnowledgeCompilationSource[];
  relevantExistingKnowledge: ProjectKnowledgeBase;
  mode: ProjectKnowledgeCompileMode;
  batchIndex?: number;
  batchCount?: number;
  signal?: AbortSignal;
}): Promise<ProjectKnowledgeExtractionBatchResult> {
  const citationSources = buildProjectKnowledgeCitationSourcesForSources(input.sources);
  const generated = await input.provider.generateStructuredOutput({
    schemaName: "ProjectKnowledgeGeneratedBase",
    schema: ProjectKnowledgeGeneratedBaseSchema,
    system: projectKnowledgeExtractionPrompt.system,
    user: buildProjectKnowledgeExtractionUserPrompt({
      scope: input.scope,
      sources: input.sources,
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
    signal: input.signal,
  });
  const initialGrounding = groundGeneratedProjectKnowledge({
    generated: generated.validatedOutput,
    sources: citationSources,
  });
  let repaired: LLMResult<ProjectKnowledgeGeneratedBase> | null = null;
  let repairGrounding: ReturnType<typeof groundGeneratedProjectKnowledge> | null = null;

  if (initialGrounding.omissions.length) {
    repaired = await input.provider.generateStructuredOutput({
      schemaName: "ProjectKnowledgeGeneratedBase",
      schema: ProjectKnowledgeGeneratedBaseSchema,
      system: projectKnowledgeExtractionPrompt.system,
      user: buildProjectKnowledgeCitationRepairPrompt({
        generated: generated.validatedOutput,
        omissions: initialGrounding.omissions,
        citationSources,
      }),
      metadata: {
        action: "project_knowledge.repair_citations",
        promptName: projectKnowledgeExtractionPrompt.name,
        promptVersion: projectKnowledgeExtractionPrompt.version,
        projectId: input.scope.projectId,
        azureProjectId: input.scope.azureProjectId,
        azureProjectName: input.scope.azureProjectName,
        azureOrganizationUrl: input.scope.azureOrganizationUrl,
      },
      signal: input.signal,
    });
    repairGrounding = groundGeneratedProjectKnowledge({
      generated: generatedProjectKnowledgeForOmissions(repaired.validatedOutput, initialGrounding.omissions),
      sources: citationSources,
    });
  }

  const repairedKeys = new Set(repairGrounding?.groundedEntryKeys ?? []);
  const repairOmissionByKey = new Map((repairGrounding?.omissions ?? []).map((omission) => [
    `${omission.category}:${omission.entryKey}`,
    omission,
  ]));
  const unresolvedOmissions = initialGrounding.omissions.flatMap((omission) => {
    const key = `${omission.category}:${omission.entryKey}`;
    if (repairedKeys.has(key)) return [];
    return [repairOmissionByKey.get(key) ?? omission];
  });
  const consolidation = consolidateProjectKnowledgeBases([
    initialGrounding.knowledgeBase,
    ...(repairGrounding ? [repairGrounding.knowledgeBase] : []),
  ]);
  const groundedEntryCount = countProjectKnowledgeEntries(consolidation.knowledgeBase);
  if (initialGrounding.candidateCount > 0 && groundedEntryCount === 0) {
    throw new AppError({
      code: AppErrorCode.SchemaValidation,
      message: "Every generated project-knowledge entry failed immutable citation validation.",
      userMessage: "The build produced no grounded knowledge. The active publication was not changed.",
      technicalContext: {
        schemaName: "ProjectKnowledgeGeneratedBase",
        upstreamCause: JSON.stringify(countGroundingOmissionReasons(unresolvedOmissions)),
      },
    });
  }

  const omissionReasons = countGroundingOmissionReasons(unresolvedOmissions);
  const omissionWarning = unresolvedOmissions.length
    ? `${unresolvedOmissions.length} unsupported knowledge ${unresolvedOmissions.length === 1 ? "entry was" : "entries were"} omitted automatically.`
    : null;
  const warnings = Array.from(new Set([
    ...(generated.warnings ?? []),
    ...(repaired?.warnings ?? []),
    omissionWarning,
  ].filter((warning): warning is string => Boolean(warning))));

  return {
    provider: generated.provider,
    model: generated.model,
    validatedOutput: consolidation.knowledgeBase,
    rawOutput: JSON.stringify({
      generated: generated.rawOutput,
      repaired: repaired?.rawOutput ?? null,
      unresolvedOmissions,
      omissionReasons,
    }),
    tokenUsage: addTokenUsage(generated.tokenUsage, repaired?.tokenUsage),
    costEstimate: (generated.costEstimate ?? 0) + (repaired?.costEstimate ?? 0) || undefined,
    warnings: warnings.length ? warnings : undefined,
    omittedEntryCount: unresolvedOmissions.length,
    omissionReasons,
    citationRepairCallCount: repaired ? 1 : 0,
    automaticDuplicateConsolidationCount: consolidation.automaticDuplicateConsolidationCount,
  };
}

function buildProjectKnowledgeCitationRepairPrompt(input: {
  generated: ProjectKnowledgeGeneratedBase;
  omissions: ProjectKnowledgeGroundingOmission[];
  citationSources: ProjectKnowledgeCitationSource[];
}) {
  return JSON.stringify({
    repairOnly: true,
    instruction: "Return only the failed entries with corrected citation handles and quotes. Use the supplied canonical source text verbatim. Omit any entry that cannot be supported. Do not invent IDs or source metadata.",
    failedEntries: generatedProjectKnowledgeForOmissions(input.generated, input.omissions),
    citationSources: input.citationSources.map(({ handle, sourceField, text }) => ({ handle, sourceField, text })),
    requiredOutputShape: PROJECT_KNOWLEDGE_GENERATED_OUTPUT_SHAPE,
  }, null, 2);
}

function countProjectKnowledgeEntries(knowledgeBase: ProjectKnowledgeBase) {
  const counts = getKnowledgeCounts(knowledgeBase);
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function countGroundingOmissionReasons(omissions: ProjectKnowledgeGroundingOmission[]) {
  return omissions.reduce<Record<string, number>>((counts, omission) => {
    for (const reason of omission.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
    return counts;
  }, {});
}

function mergeCountMaps(maps: Record<string, number>[]) {
  return maps.reduce<Record<string, number>>((merged, counts) => {
    for (const [key, count] of Object.entries(counts)) merged[key] = (merged[key] ?? 0) + count;
    return merged;
  }, {});
}

function buildProjectKnowledgeExtractionUserPrompt(input: {
  scope: ProjectScope;
  sources: ProjectKnowledgeCompilationSource[];
  relevantExistingKnowledge?: ProjectKnowledgeBase;
  mode: ProjectKnowledgeCompileMode;
  batchIndex?: number;
  batchCount?: number;
}) {
  return JSON.stringify({
    extractionMode: input.batchCount ? "batch" : input.mode,
    knowledgeCompileMode: input.mode,
    incrementalInstruction: input.mode === "incremental"
      ? "Reconcile every relevantExistingKnowledge entry against the changed immutable sources. Return still-supported, updated, and newly supported entries; omitted source-linked claims are retired deterministically."
      : undefined,
    batchIndex: input.batchIndex,
    batchCount: input.batchCount,
    sources: input.sources.map(toPromptSource),
    relevantExistingKnowledge: input.mode === "incremental" && input.relevantExistingKnowledge
      ? projectKnowledgeBaseToGeneratedPrompt(input.relevantExistingKnowledge)
      : undefined,
    requiredOutputShape: PROJECT_KNOWLEDGE_GENERATED_OUTPUT_SHAPE,
    projectScope: {
      azureProjectId: input.scope.azureProjectId,
      azureProjectName: input.scope.azureProjectName,
    },
  }, null, 2);
}

async function loadProjectKnowledgeSourcesFromManifest(
  scope: ProjectScope,
  manifest: ProjectKnowledgeDraft["sourceManifest"],
): Promise<ProjectKnowledgeCompilationSource[]> {
  const [workItems, documentChunks] = await Promise.all([
    loadProjectKnowledgeWorkItemsFromManifest(scope, manifest),
    loadProjectSourceDocumentChunksFromManifest(scope, manifest),
  ]);
  return [...workItems, ...documentChunks];
}

function loadProjectKnowledgeWorkItemsFromManifest(
  scope: ProjectScope,
  manifest: ProjectKnowledgeDraft["sourceManifest"],
): Promise<ProjectKnowledgeWorkItem[]> {
  ensureProjectContextSyncSchema();
  const workItemManifest = manifest.filter((entry) => !isProjectKnowledgeDocumentSourceManifestEntry(entry));
  if (!workItemManifest.length) return Promise.resolve([]);
  const snapshotIds = workItemManifest.map((entry) => entry.sourceSnapshotId);
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
        const projected = (sourceField: Parameters<typeof projectKnowledgeCanonicalSourceText>[1]) =>
          projectKnowledgeCanonicalSourceText(fields[sourceField], sourceField) || undefined;
        return {
          kind: "work_item" as const,
          id: row.azure_work_item_id,
          sourceSnapshotId: row.id,
          workItemType: row.work_item_type,
          title: projected("title") ?? "",
          state: projected("state"),
          description: projected("description"),
          acceptanceCriteria: projected("acceptanceCriteria"),
          tags: snapshotTags(fields.tags),
          areaPath: projected("areaPath"),
          iterationPath: projected("iterationPath"),
          updatedDate: row.source_updated_at ?? undefined,
          contentHash: row.content_hash,
        };
      });
    if (items.length !== workItemManifest.length) {
      const found = new Set(items.map((item) => item.sourceSnapshotId));
      const missing = snapshotIds.filter((id) => !found.has(id));
      throw new Error(`Draft source snapshots are missing: ${missing.join(", ")}`);
    }
    return items;
  });
}

async function loadProjectSourceDocumentChunksFromManifest(
  scope: ProjectScope,
  manifest: ProjectKnowledgeDraft["sourceManifest"],
): Promise<ProjectKnowledgeDocumentChunk[]> {
  const documentManifest = manifest.filter(isProjectKnowledgeDocumentSourceManifestEntry);
  if (!documentManifest.length) return [];
  const sourceDocumentVersionIds = documentManifest.map((entry) => entry.sourceDocumentVersionId);
  const manifestOrder = new Map(sourceDocumentVersionIds.map((id, index) => [id, index]));
  const rows = await sqlAll<ProjectKnowledgeDocumentChunkRow>(
    `
      SELECT chunks.id, chunks.document_id, chunks.source_document_version_id,
             chunks.document_name, chunks.document_type, chunks.section,
             chunks.page_number, chunks.chunk_index, chunks.content,
             chunks.metadata_json, versions.content_hash
      FROM document_chunks chunks
      JOIN project_source_document_versions versions
        ON versions.id = chunks.source_document_version_id
       AND versions.document_id = chunks.document_id
      WHERE chunks.workspace_id = @workspaceId
        AND chunks.project_id = @projectId
        AND chunks.azure_project_id = @azureProjectId
        AND chunks.source_type = 'uploaded_document'
        AND chunks.source_document_version_id = ANY(@sourceDocumentVersionIds::text[])
      ORDER BY chunks.source_document_version_id, chunks.chunk_index, chunks.id
    `,
    {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceDocumentVersionIds,
    },
  );
  return rows
    .sort((first, second) =>
      (manifestOrder.get(first.source_document_version_id) ?? 0) -
      (manifestOrder.get(second.source_document_version_id) ?? 0) ||
      first.chunk_index - second.chunk_index ||
      first.id.localeCompare(second.id))
    .map((row) => {
      const metadata = snapshotFields(row.metadata_json);
      const origin = typeof metadata.origin === "string" ? metadata.origin : "";
      return {
        kind: "document" as const,
        id: row.id,
        sourceDocumentId: row.document_id,
        sourceDocumentVersionId: row.source_document_version_id,
        documentName: row.document_name,
        documentType: row.document_type ?? undefined,
        section: row.section,
        pageNumber: row.page_number,
        content: row.content,
        metadata,
        contentHash: row.content_hash,
        ...(origin === "ocr_text" || origin === "vision_interpretation"
          ? { verification: "unverified" as const }
          : {}),
      };
    });
}

function snapshotFields(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return snapshotFields(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function snapshotTags(value: unknown) {
  if (Array.isArray(value)) return value.filter((tag): tag is string => typeof tag === "string");
  return typeof value === "string" ? parseTags(value) : undefined;
}

function buildProjectKnowledgeSourceBatches(sources: ProjectKnowledgeCompilationSource[]) {
  const batches: ProjectKnowledgeCompilationSource[][] = [];
  let current: ProjectKnowledgeCompilationSource[] = [];
  let currentChars = 0;

  sources.forEach((source) => {
    const sourceChars = JSON.stringify(source).length;
    if (current.length && currentChars + sourceChars > MAX_CONTEXT_INPUT_CHARS) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(source);
    currentChars += sourceChars;
  });

  if (current.length) batches.push(current);
  return batches.length ? batches : [[]];
}

type ProjectKnowledgeExtractionJob = {
  sources: ProjectKnowledgeCompilationSource[];
  relevantExistingKnowledge: ProjectKnowledgeBase;
};

function buildProjectKnowledgeExtractionJobs(input: {
  scope: ProjectScope;
  sources: ProjectKnowledgeCompilationSource[];
  existingKnowledgeBase: ProjectKnowledgeBase | null;
  mode: ProjectKnowledgeCompileMode;
  maxInputTokens: number;
}) {
  const sourceBatches = buildProjectKnowledgeSourceBatches(input.sources);
  const jobs: ProjectKnowledgeExtractionJob[] = [];
  for (const sources of sourceBatches) {
    const sourceIds = new Set(projectKnowledgeSourceKeys(sources));
    const relevantEntries = input.mode === "incremental" && input.existingKnowledgeBase
      ? flattenRawKnowledgeEntries(input.existingKnowledgeBase).filter((entry) =>
          entry.sourceIds.some((sourceId) => sourceIds.has(sourceId)),
        )
      : [];
    const emptyKnowledge = emptyProjectKnowledgeBase();
    if (!relevantEntries.length) {
      assertKnowledgeExtractionJobFits({ ...input, sources, relevantExistingKnowledge: emptyKnowledge });
      jobs.push({ sources, relevantExistingKnowledge: emptyKnowledge });
      continue;
    }

    let currentEntries: ReturnType<typeof flattenRawKnowledgeEntries> = [];
    for (const entry of relevantEntries) {
      const candidateEntries = [...currentEntries, entry];
      const candidateKnowledge = knowledgeBaseFromRawEntries(candidateEntries);
      if (knowledgeExtractionJobFits({ ...input, sources, relevantExistingKnowledge: candidateKnowledge })) {
        currentEntries = candidateEntries;
        continue;
      }
      if (!currentEntries.length) {
        throw new Error(
          `Exact source-linked knowledge entry ${entry.category}:${entry.entryKey} cannot fit the rendered ${input.maxInputTokens.toLocaleString()}-token input budget.`,
        );
      }
      jobs.push({
        sources,
        relevantExistingKnowledge: knowledgeBaseFromRawEntries(currentEntries),
      });
      currentEntries = [entry];
      assertKnowledgeExtractionJobFits({
        ...input,
        sources,
        relevantExistingKnowledge: knowledgeBaseFromRawEntries(currentEntries),
      });
    }
    if (currentEntries.length) {
      jobs.push({ sources, relevantExistingKnowledge: knowledgeBaseFromRawEntries(currentEntries) });
    }
  }
  return jobs;
}

function knowledgeExtractionJobFits(input: {
  scope: ProjectScope;
  sources: ProjectKnowledgeCompilationSource[];
  relevantExistingKnowledge: ProjectKnowledgeBase;
  mode: ProjectKnowledgeCompileMode;
  maxInputTokens: number;
}) {
  const renderedChars = renderedKnowledgeJobChars(input);
  return Math.ceil(renderedChars / 4) <= Math.floor(input.maxInputTokens * 0.9);
}

function renderedKnowledgeJobChars(input: {
  scope: ProjectScope;
  sources: ProjectKnowledgeCompilationSource[];
  relevantExistingKnowledge: ProjectKnowledgeBase;
  mode: ProjectKnowledgeCompileMode;
  batchIndex?: number;
  batchCount?: number;
}) {
  const user = buildProjectKnowledgeExtractionUserPrompt({
    scope: input.scope,
    sources: input.sources,
    relevantExistingKnowledge: input.relevantExistingKnowledge,
    mode: input.mode,
    batchIndex: input.batchIndex,
    batchCount: input.batchCount,
  });
  return projectKnowledgeExtractionPrompt.system.length +
    user.length +
    JSON.stringify(PROJECT_KNOWLEDGE_GENERATED_OUTPUT_SHAPE).length;
}

function assertKnowledgeExtractionJobFits(input: Parameters<typeof knowledgeExtractionJobFits>[0]) {
  if (knowledgeExtractionJobFits(input)) return;
  const sourceId = input.sources[0] ? projectKnowledgeSourceKey(input.sources[0]) : "unknown";
  throw new Error(
    `Source ${sourceId} cannot fit the rendered ${input.maxInputTokens.toLocaleString()}-token input budget.`,
  );
}

type RawKnowledgeEntry = {
  category: "modules" | "businessRules" | "stateTransitions" | "glossary" | "crossDependencies";
  entryKey: string;
  sourceIds: string[];
  value: Record<string, unknown>;
};

function flattenRawKnowledgeEntries(knowledgeBase: ProjectKnowledgeBase): RawKnowledgeEntry[] {
  return [
    ...knowledgeBase.modules.map((value) => ({ category: "modules" as const, entryKey: value.id, sourceIds: projectKnowledgeEntrySourceIds(value), value })),
    ...knowledgeBase.businessRules.map((value) => ({ category: "businessRules" as const, entryKey: value.id, sourceIds: projectKnowledgeEntrySourceIds(value), value })),
    ...knowledgeBase.stateTransitions.map((value) => ({ category: "stateTransitions" as const, entryKey: value.id, sourceIds: projectKnowledgeEntrySourceIds(value), value })),
    ...knowledgeBase.glossary.map((value) => ({ category: "glossary" as const, entryKey: value.term, sourceIds: projectKnowledgeEntrySourceIds(value), value })),
    ...knowledgeBase.crossDependencies.map((value) => ({ category: "crossDependencies" as const, entryKey: value.id, sourceIds: projectKnowledgeEntrySourceIds(value), value })),
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
  const draft = await getProjectKnowledgeDraft({ scope: input.scope, draftId: input.draftId });
  if (!draft) {
    throw new AppError({
      code: AppErrorCode.ResourceNotFound,
      message: "The knowledge draft was not found while validating a manual batch.",
      userMessage: "The knowledge draft was not found.",
    });
  }
  const sources = await loadProjectKnowledgeSourcesFromManifest(input.scope, draft.sourceManifest);
  const grounding = groundManualProjectKnowledgeOutput({ rawOutput: input.rawOutput, sources });
  const knowledgeBase = grounding.knowledgeBase;
  await saveProjectKnowledgeManualBatchResult({
    ...input,
    validatedOutput: knowledgeBase,
  });
  return knowledgeBase;
}

function groundManualProjectKnowledgeOutput(input: {
  rawOutput: string;
  sources: ProjectKnowledgeCompilationSource[];
}) {
  const generated = validateProjectKnowledgeGeneratedExternalOutput(input.rawOutput);
  const grounding = groundGeneratedProjectKnowledge({
    generated,
    sources: buildProjectKnowledgeCitationSourcesForSources(input.sources),
  });
  if (grounding.candidateCount > 0 && grounding.groundedEntryCount === 0) {
    throw new AppError({
      code: AppErrorCode.SchemaValidation,
      message: "Every manually generated project-knowledge entry failed immutable citation validation.",
      userMessage: "No supported knowledge entries were found. Check the citation handles and quotes, then try again.",
      technicalContext: {
        schemaName: "ProjectKnowledgeGeneratedBase",
        upstreamCause: JSON.stringify(grounding.omissionReasons),
      },
    });
  }
  return grounding;
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
