import "server-only";

import type { PoolClient } from "pg";

import { writeAuditLogTransactional } from "@/modules/audit/audit.service";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import {
  createId,
  nowIso,
  sqlAll,
  sqlGet,
  sqlRun,
  withTransaction,
} from "@/modules/shared/infrastructure/database/db";
import { refreshProjectKnowledgeSearchIndex } from "./context-chatbot-retrieval.service";
import {
  PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
  PROJECT_KNOWLEDGE_MANUAL_DRAFT_TTL_MS,
  PROJECT_KNOWLEDGE_MAX_REBASE_DEPTH,
  PROJECT_KNOWLEDGE_PROVENANCE_HASH_VERSION,
  PROJECT_KNOWLEDGE_SEMANTIC_HASH_VERSION,
  PROJECT_KNOWLEDGE_WORDING_VERSION,
  ProjectKnowledgeSourceManifestSchema,
  canonicalizeBusinessRuleSourceFieldForProjection,
  canonicalizeProjectKnowledgeLogicalIdentity,
  computeProjectKnowledgeHashes,
  computeProjectKnowledgeSourceFingerprint,
  displayProjectKnowledgeDraftStatus,
  getEntryProvenanceStatus,
  hashCanonicalValue,
  flattenProjectKnowledgeSemanticEntries,
  type ProjectKnowledgeDraftStatus,
  type ProjectKnowledgeEntryCategory,
  type ProjectKnowledgeOperation,
  type ProjectKnowledgeSourceManifestEntry,
} from "./project-knowledge-contracts";
import {
  mergeProjectKnowledgeConflictEntries,
  type ProjectKnowledgeConsolidationCategory,
  type ProjectKnowledgeEntryByConsolidationCategory,
} from "./project-knowledge-consolidation";
import {
  recordProjectKnowledgeRevision,
  runProjectKnowledgeLint,
  type ProjectKnowledgeCompilationMode,
} from "./project-knowledge-compiled.service";
import {
  detectProjectKnowledgeHardConflicts,
  sortProjectKnowledgeHardConflictsForReview,
  type ProjectKnowledgeHardConflict,
} from "./project-knowledge-conflicts";
import { acquireProjectKnowledgeLock } from "./project-knowledge-lock";
import { backfillProjectKnowledgeCompilerFoundation } from "./project-knowledge-migration.service";
import { evaluateAutomaticProvenanceRefresh } from "./project-knowledge-publication-policy";
import {
  findUniqueProjectKnowledgeEvidenceAnchor,
  repairMissingProjectKnowledgeEvidenceRefs,
} from "./project-knowledge-evidence-repair";
import {
  verifyProjectKnowledgeEvidence,
  type ProjectKnowledgeEvidenceBlocker as ProjectKnowledgeVerificationBlocker,
  type ProjectKnowledgeEvidenceSnapshot,
} from "./project-knowledge-provenance";
import {
  normalizeProjectKnowledgeBlockers,
  projectKnowledgeBlockerId,
  projectKnowledgeEntryInstanceId,
  projectKnowledgeEntryInstances,
  summarizeProjectKnowledgeReview,
  type ProjectKnowledgeDraftBlocker,
  type ProjectKnowledgeReviewContext,
  type ProjectKnowledgeReviewSummary,
} from "./project-knowledge-review.contracts";
import {
  buildProjectKnowledgeOperations,
  replayProjectKnowledgeOperations,
  type ProjectKnowledgeVersionPrecondition,
} from "./project-knowledge-reconciliation";
import {
  PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS,
  PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
  PROJECT_KNOWLEDGE_SOURCE_FIELDS,
  ProjectKnowledgeBaseSchema,
  splitProjectKnowledgeLegacyEvidence,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeEvidenceRef,
} from "./project-knowledge.schema";

type DraftRow = {
  id: string;
  generation_mode: "automatic" | "manual";
  compilation_mode: ProjectKnowledgeCompilationMode;
  status: ProjectKnowledgeDraftStatus;
  status_reason: string | null;
  parent_draft_id: string | null;
  rebase_depth: number;
  base_revision_id: string | null;
  source_manifest_json: unknown;
  source_fingerprint: string;
  compiler_contract_version: string;
  wording_version: string;
  provider: string | null;
  model_name: string | null;
  raw_output: string | null;
  proposed_knowledge_json: unknown;
  operations_json: unknown;
  generation_data_json: unknown;
  blockers_json: unknown;
  metrics_json: unknown;
  semantic_hash: string | null;
  provenance_hash: string | null;
  pending_drift: boolean;
  heartbeat_at: string | null;
  review_ready_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

type CurrentKnowledgeRow = {
  id: string;
  active_revision_id: string | null;
  validated_output: string;
  semantic_hash: string | null;
  provenance_hash: string | null;
};

export type ProjectKnowledgePublicationIntent = "human_reviewed" | "automatic_provenance_refresh";

type SourceManifestRow = {
  source_snapshot_id: string;
  source_work_item_id: string;
  work_item_type: string;
  content_hash: string;
  ado_revision: number | null;
  source_updated_at: string | null;
  captured_at: string;
};

type EvidenceSnapshotRow = {
  id: string;
  azure_work_item_id: string;
  fields_json: unknown;
};

export type ProjectKnowledgeDraft = {
  id: string;
  generationMode: "automatic" | "manual";
  compilationMode: ProjectKnowledgeCompilationMode;
  status: ReturnType<typeof displayProjectKnowledgeDraftStatus>;
  persistedStatus: ProjectKnowledgeDraftStatus;
  statusReason: string | null;
  parentDraftId: string | null;
  rebaseDepth: number;
  baseRevisionId: string | null;
  sourceManifest: ProjectKnowledgeSourceManifestEntry[];
  sourceFingerprint: string;
  compilerContractVersion: string;
  regenerateRequired: boolean;
  wordingVersion: string;
  provider: string | null;
  model: string | null;
  rawOutput: string | null;
  proposedKnowledge: ProjectKnowledgeBase | null;
  /** Compatibility alias for callers migrated from snapshot-returning finalization. */
  knowledgeBase: ProjectKnowledgeBase | null;
  operations: ProjectKnowledgeOperation[];
  blockers: ProjectKnowledgeDraftBlocker[];
  reviewSummary: ProjectKnowledgeReviewSummary;
  metrics: Record<string, unknown>;
  semanticHash: string | null;
  provenanceHash: string | null;
  pendingDrift: boolean;
  heartbeatAt: string | null;
  reviewReadyAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};

export async function beginProjectKnowledgeDraft(input: {
  scope: ProjectScope;
  actor: string;
  generationMode: "automatic" | "manual";
  compilationMode: ProjectKnowledgeCompilationMode;
  parentDraftId?: string | null;
}) {
  const scope = assertProjectScope(input.scope);
  try {
    return await withTransaction(async (client) => {
    await acquireProjectKnowledgeLock(scope, client);
    await backfillProjectKnowledgeCompilerFoundation(scope, client);
    await expireManualProjectKnowledgeDrafts(scope, client);
    const parent = input.parentDraftId
      ? await getDraftRow(scope, input.parentDraftId, client, true)
      : undefined;
    if (input.parentDraftId && !parent) throw draftNotFound();
    if (parent && parent.status !== "rebase_required") throw draftStateConflict(parent.status);
    if (parent && parent.generation_mode !== input.generationMode) {
      throw new AppError({
        code: AppErrorCode.KnowledgeDraftConflict,
        message: "A rebased draft must preserve its generation mode.",
        userMessage: "Regenerate this draft using the same automatic or manual workflow.",
      });
    }
    const rebaseDepth = parent ? parent.rebase_depth + 1 : 0;
    if (rebaseDepth > PROJECT_KNOWLEDGE_MAX_REBASE_DEPTH) {
      throw new AppError({
        code: AppErrorCode.KnowledgeDraftConflict,
        message: "Knowledge draft rebase depth exceeded.",
        userMessage: "This draft has drifted too many times. Generate a fresh full preview.",
      });
    }

    const manifest = await loadCurrentProjectKnowledgeSourceManifest(scope, client);
    const current = await loadCurrentKnowledge(scope, client);
    const baseVersions = await loadActiveEntryVersions(scope, client);
    const now = nowIso();
    const id = createId("pkd");
    const status: ProjectKnowledgeDraftStatus = input.generationMode === "manual" ? "awaiting_input" : "generating";
    await sqlRun(
      `
        INSERT INTO project_knowledge_drafts (
          id, workspace_id, project_id, azure_project_id, azure_project_name,
          azure_organization_url, generation_mode, compilation_mode, status,
          parent_draft_id, rebase_depth, base_revision_id, source_manifest_json,
          source_fingerprint, compiler_contract_version, wording_version,
          generation_data_json, heartbeat_at, created_by, created_at, updated_at
        ) VALUES (
          @id, (SELECT workspace_id FROM projects WHERE id = @projectId), @projectId,
          @azureProjectId, @azureProjectName, @azureOrganizationUrl, @generationMode,
          @compilationMode, @status, @parentDraftId, @rebaseDepth, @baseRevisionId,
          @sourceManifestJson, @sourceFingerprint, @compilerContractVersion,
          @wordingVersion, @generationDataJson, @heartbeatAt, @createdBy,
          @createdAt, @updatedAt
        )
      `,
      {
        id,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
        azureOrganizationUrl: scope.azureOrganizationUrl,
        generationMode: input.generationMode,
        compilationMode: input.compilationMode,
        status,
        parentDraftId: input.parentDraftId ?? null,
        rebaseDepth,
        baseRevisionId: current?.active_revision_id ?? null,
        sourceManifestJson: JSON.stringify(manifest),
        sourceFingerprint: computeProjectKnowledgeSourceFingerprint(manifest),
        compilerContractVersion: PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
        wordingVersion: PROJECT_KNOWLEDGE_WORDING_VERSION,
        generationDataJson: JSON.stringify({
          baseKnowledgeBase: current
            ? ProjectKnowledgeBaseSchema.parse(JSON.parse(current.validated_output))
            : null,
          baseVersions,
        }),
        heartbeatAt: now,
        createdBy: input.actor,
        createdAt: now,
        updatedAt: now,
      },
      client,
    );
    await writeAuditLogTransactional({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_knowledge_draft",
      entityId: id,
      action: "rag.knowledge_draft.created",
      status: "Pending",
      actor: input.actor,
      message: "Created a source-versioned project knowledge draft.",
      details: { generationMode: input.generationMode, compilationMode: input.compilationMode },
    }, client);
    return requireDraft(scope, id, client);
    });
  } catch (error) {
    if (input.parentDraftId && isLiveChildUniqueViolation(error)) throw liveChildConflict();
    throw error;
  }
}

export async function heartbeatProjectKnowledgeDraft(input: { scope: ProjectScope; draftId: string }) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  await sqlRun(
    `
      UPDATE project_knowledge_drafts
      SET heartbeat_at = @now, updated_at = @now
      WHERE id = @draftId AND project_id = @projectId AND azure_project_id = @azureProjectId
        AND status = 'generating'
    `,
    { draftId: input.draftId, projectId: scope.projectId, azureProjectId: scope.azureProjectId, now },
  );
}

export async function setProjectKnowledgeDraftCompilationMode(input: {
  scope: ProjectScope;
  draftId: string;
  compilationMode: ProjectKnowledgeCompilationMode;
}) {
  const scope = assertProjectScope(input.scope);
  await sqlRun(
    `
      UPDATE project_knowledge_drafts
      SET compilation_mode = @compilationMode, updated_at = @now
      WHERE id = @draftId AND project_id = @projectId AND azure_project_id = @azureProjectId
        AND status IN ('generating', 'awaiting_input')
    `,
    {
      draftId: input.draftId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      compilationMode: input.compilationMode,
      now: nowIso(),
    },
  );
}

export async function storeProjectKnowledgeManualDraftBatches(input: {
  scope: ProjectScope;
  draftId: string;
  batches: Array<{
    batchIndex: number;
    systemPrompt: string;
    userPrompt: string;
  }>;
}) {
  const scope = assertProjectScope(input.scope);
  return withTransaction(async (client) => {
    await acquireProjectKnowledgeLock(scope, client);
    await backfillProjectKnowledgeCompilerFoundation(scope, client);
    const draft = await getDraftRow(scope, input.draftId, client, true);
    if (!draft) throw draftNotFound();
    if (draft.generation_mode !== "manual" || draft.status !== "awaiting_input") {
      throw draftStateConflict(draft.status);
    }
    const carryCandidates = draft.parent_draft_id
      ? await sqlAll<{
          prompt_hash: string;
          compiler_contract_version: string;
          raw_output: string | null;
          validated_output: unknown;
        }>(
          `
            SELECT prompt_hash, compiler_contract_version, raw_output, validated_output
            FROM project_knowledge_draft_batches
            WHERE draft_id = @parentDraftId AND status = 'validated'
          `,
          { parentDraftId: draft.parent_draft_id },
          client,
        )
      : [];
    const carryByPromptHash = new Map(carryCandidates
      .filter((candidate) =>
        candidate.compiler_contract_version === draft.compiler_contract_version &&
        candidate.raw_output !== null && candidate.validated_output !== null,
      )
      .map((candidate) => [candidate.prompt_hash, candidate]));
    await sqlRun("DELETE FROM project_knowledge_draft_batches WHERE draft_id = @draftId", { draftId: draft.id }, client);
    const now = nowIso();
    const carriedBatches: Array<{
      batchIndex: number;
      rawOutput: string;
      validatedOutput: ProjectKnowledgeBase;
    }> = [];
    for (const batch of input.batches) {
      const promptHash = hashCanonicalValue({ system: batch.systemPrompt, user: batch.userPrompt });
      const carried = carryByPromptHash.get(promptHash);
      const validatedOutput = carried?.validated_output
        ? ProjectKnowledgeBaseSchema.parse(carried.validated_output)
        : null;
      await sqlRun(
        `
          INSERT INTO project_knowledge_draft_batches (
            id, draft_id, batch_index, status, prompt_hash,
            compiler_contract_version, system_prompt, user_prompt,
            raw_output, validated_output, heartbeat_at, created_at, updated_at
          ) VALUES (
            @id, @draftId, @batchIndex, @status, @promptHash,
            @compilerContractVersion, @systemPrompt, @userPrompt,
            @rawOutput, @validatedOutputJson, @heartbeatAt, @createdAt, @updatedAt
          )
        `,
        {
          id: createId("pkdb"),
          draftId: draft.id,
          batchIndex: batch.batchIndex,
          status: validatedOutput ? "validated" : "awaiting_input",
          promptHash,
          compilerContractVersion: draft.compiler_contract_version,
          systemPrompt: batch.systemPrompt,
          userPrompt: batch.userPrompt,
          rawOutput: validatedOutput ? carried!.raw_output : null,
          validatedOutputJson: validatedOutput ? JSON.stringify(validatedOutput) : null,
          heartbeatAt: now,
          createdAt: now,
          updatedAt: now,
        },
        client,
      );
      if (validatedOutput) {
        carriedBatches.push({
          batchIndex: batch.batchIndex,
          rawOutput: carried!.raw_output!,
          validatedOutput,
        });
      }
    }
    return {
      draft: await requireDraft(scope, draft.id, client),
      carriedBatches,
    };
  });
}

export async function loadProjectKnowledgeManualBatchResults(input: {
  scope: ProjectScope;
  draftId: string;
}) {
  const scope = assertProjectScope(input.scope);
  const draft = await requireDraft(scope, input.draftId);
  if (draft.generationMode !== "manual" || draft.persistedStatus !== "awaiting_input") {
    throw draftStateConflict(draft.persistedStatus);
  }
  const rows = await sqlAll<{
    batch_index: number;
    status: string;
    raw_output: string | null;
    validated_output: unknown;
    system_prompt: string;
    user_prompt: string;
  }>(
    `
      SELECT batches.batch_index, batches.status, batches.raw_output, batches.validated_output,
             batches.system_prompt, batches.user_prompt
      FROM project_knowledge_draft_batches batches
      JOIN project_knowledge_drafts drafts ON drafts.id = batches.draft_id
      WHERE batches.draft_id = @draftId
        AND drafts.project_id = @projectId AND drafts.azure_project_id = @azureProjectId
      ORDER BY batches.batch_index
    `,
    { draftId: input.draftId, projectId: scope.projectId, azureProjectId: scope.azureProjectId },
  );
  const validated = rows.filter((row) => row.status === "validated" && row.validated_output !== null);
  return {
    batchCount: rows.length,
    validatedCount: validated.length,
    partialKnowledgeBases: validated.map((row) => ProjectKnowledgeBaseSchema.parse(row.validated_output)),
    rawOutputs: validated.map((row) => row.raw_output ?? ""),
    renderedPromptChars: rows.reduce(
      (total, row) => total + row.system_prompt.length + row.user_prompt.length +
        JSON.stringify(PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE).length,
      0,
    ),
  };
}

export async function saveProjectKnowledgeManualBatchResult(input: {
  scope: ProjectScope;
  draftId: string;
  batchIndex: number;
  rawOutput: string;
  validatedOutput: ProjectKnowledgeBase;
}) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  const updated = await sqlRun(
    `
      UPDATE project_knowledge_draft_batches batches
      SET status = 'validated', raw_output = @rawOutput,
          validated_output = @validatedOutputJson, heartbeat_at = @now, updated_at = @now
      FROM project_knowledge_drafts drafts
      WHERE batches.draft_id = drafts.id
        AND batches.draft_id = @draftId AND batches.batch_index = @batchIndex
        AND drafts.project_id = @projectId AND drafts.azure_project_id = @azureProjectId
        AND drafts.status = 'awaiting_input'
    `,
    {
      draftId: input.draftId,
      batchIndex: input.batchIndex,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      rawOutput: input.rawOutput,
      validatedOutputJson: JSON.stringify(ProjectKnowledgeBaseSchema.parse(input.validatedOutput)),
      now,
    },
  );
  if (!updated) throw draftStateConflict("missing_or_not_awaiting_input");
  await sqlRun(
    `UPDATE project_knowledge_drafts SET heartbeat_at = @now, updated_at = @now WHERE id = @draftId`,
    { draftId: input.draftId, now },
  );
}

export async function completeProjectKnowledgeDraft(input: {
  scope: ProjectScope;
  draftId: string;
  provider: string;
  model: string;
  rawOutput: string;
  knowledgeBase: ProjectKnowledgeBase;
  metrics?: Record<string, unknown>;
  touchedSourceWorkItemIds?: string[];
  recoverMissingEvidenceRefs?: boolean;
}) {
  const scope = assertProjectScope(input.scope);
  const boundaryConsolidation = consolidateSafeProjectKnowledgeDuplicates(
    ProjectKnowledgeBaseSchema.parse(input.knowledgeBase),
  );
  const parsedKnowledge = boundaryConsolidation.knowledgeBase;

  return withTransaction(async (client) => {
    await acquireProjectKnowledgeLock(scope, client);
    const row = await getDraftRow(scope, input.draftId, client, true);
    if (!row) throw draftNotFound();
    if (!["generating", "awaiting_input", "ready_for_review", "blocked"].includes(row.status)) {
      throw draftStateConflict(row.status);
    }
    const generationData = asRecord(row.generation_data_json);
    const baseKnowledgeBase = generationData.baseKnowledgeBase
      ? ProjectKnowledgeBaseSchema.parse(generationData.baseKnowledgeBase)
      : null;
    const baseVersions = asArray(generationData.baseVersions) as ProjectKnowledgeVersionPrecondition[];
    const touchedKeys = input.touchedSourceWorkItemIds
      ? knowledgeEntryKeysForSources(
          [baseKnowledgeBase, parsedKnowledge].filter((value): value is ProjectKnowledgeBase => Boolean(value)),
          new Set(input.touchedSourceWorkItemIds),
        )
      : undefined;
    const draftManifest = ProjectKnowledgeSourceManifestSchema.parse(asArray(row.source_manifest_json));
    const evidenceSnapshots = await loadEvidenceSnapshots(scope, parsedKnowledge, draftManifest, client);
    const repair = input.recoverMissingEvidenceRefs === false
      ? {
          knowledgeBase: parsedKnowledge,
          attemptedEntryCount: 0,
          repairedEntryCount: 0,
          unresolvedEntryCount: 0,
        }
      : repairMissingProjectKnowledgeEvidenceRefs({
          knowledgeBase: parsedKnowledge,
          snapshots: evidenceSnapshots,
          touchedKeys,
          fallbackSourceWorkItemIds: new Set(draftManifest.map((entry) => entry.sourceWorkItemId)),
        });
    const verification = verifyProjectKnowledgeEvidence({
      knowledgeBase: repair.knowledgeBase,
      snapshots: evidenceSnapshots,
    });
    const conflicts = detectProjectKnowledgeHardConflicts(verification.knowledgeBase);
    const hashes = computeProjectKnowledgeHashes(verification.knowledgeBase);
    const operations: ProjectKnowledgeOperation[] = buildProjectKnowledgeOperations({
      baseKnowledgeBase,
      proposedKnowledgeBase: verification.knowledgeBase,
      baseVersions,
      touchedKeys,
    });
    operations.push(...hardConflictOperations(conflicts));
    const currentManifest = await loadCurrentProjectKnowledgeSourceManifest(scope, client);
    const sourceDrifted = computeProjectKnowledgeSourceFingerprint(currentManifest) !== row.source_fingerprint;
    const hardConflictBlockers = buildHardConflictBlockers(conflicts);
    const suppressedEntryInstanceIds = hardConflictParticipantInstanceIds(conflicts);
    const v2Blockers = validateTouchedV2Knowledge(
      verification.knowledgeBase,
      touchedKeys,
      suppressedEntryInstanceIds,
    );
    const evidenceBlockers = buildEvidenceReviewBlockers(
      verification.knowledgeBase,
      verification.blockers,
      conflicts,
    );
    const blockers = normalizeProjectKnowledgeBlockers([
      ...evidenceBlockers,
      ...v2Blockers,
      ...hardConflictBlockers,
    ]);
    const status: ProjectKnowledgeDraftStatus = row.pending_drift || sourceDrifted
      ? "rebase_required"
      : blockers.length
        ? "blocked"
        : "ready_for_review";
    const statusReason = status === "rebase_required"
      ? "source_drift"
      : status === "blocked"
        ? conflicts.length ? "hard_conflict" : "publication_blockers"
        : null;
    const now = nowIso();
    await sqlRun(
      `
        UPDATE project_knowledge_drafts
        SET status = @status, status_reason = @statusReason, provider = @provider,
            model_name = @model, raw_output = @rawOutput,
            proposed_knowledge_json = @proposedKnowledgeJson,
            operations_json = @operationsJson, blockers_json = @blockersJson,
            metrics_json = @metricsJson, semantic_hash = @semanticHash,
            provenance_hash = @provenanceHash, heartbeat_at = @heartbeatAt,
            pending_drift = CASE WHEN @sourceDrifted THEN true ELSE pending_drift END,
            review_ready_at = CASE
              WHEN @reviewReady THEN COALESCE(review_ready_at, @updatedAt)
              ELSE review_ready_at
            END,
            updated_at = @updatedAt
        WHERE id = @draftId
      `,
      {
        draftId: row.id,
        status,
        statusReason,
        provider: input.provider,
        model: input.model,
        rawOutput: input.rawOutput,
        proposedKnowledgeJson: JSON.stringify(verification.knowledgeBase),
        operationsJson: JSON.stringify(operations),
        blockersJson: JSON.stringify(blockers),
        metricsJson: JSON.stringify({
          ...(input.metrics ?? {}),
          automaticDuplicateConsolidationCount:
            numberMetric(input.metrics?.automaticDuplicateConsolidationCount) +
            boundaryConsolidation.automaticDuplicateConsolidationCount,
          quoteExactCount: verification.counts.exact,
          quoteNormalizedCount: verification.counts.normalized,
          quoteAutoReanchorCount: verification.counts.autoReanchored,
          quoteMismatchCount: verification.counts.mismatch,
          autoEvidenceRepairAttemptedCount: repair.attemptedEntryCount,
          autoEvidenceRepairCount: repair.repairedEntryCount,
          autoEvidenceRepairUnresolvedCount: repair.unresolvedEntryCount,
          manualReanchorCount: allEvidenceRefs(verification.knowledgeBase)
            .filter((ref) => ref.origin === "reviewer_reanchored").length,
          touchedEntryCount: operations.length,
          conflictCount: conflicts.length,
        }),
        semanticHash: hashes.semanticKnowledgeHash,
        provenanceHash: hashes.provenanceHash,
        heartbeatAt: now,
        sourceDrifted,
        reviewReady: status === "ready_for_review" || status === "blocked",
        updatedAt: now,
      },
      client,
    );

    await persistProjectKnowledgeHardConflicts(scope, row.id, conflicts, now, client);
    return requireDraft(scope, row.id, client);
  });
}

export async function failProjectKnowledgeDraft(input: {
  scope: ProjectScope;
  draftId: string;
  reason: string;
}) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  await sqlRun(
    `
      UPDATE project_knowledge_drafts
      SET status = 'failed', status_reason = @reason, updated_at = @now, heartbeat_at = @now
      WHERE id = @draftId AND project_id = @projectId AND azure_project_id = @azureProjectId
        AND status IN ('generating', 'awaiting_input')
    `,
    {
      draftId: input.draftId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      reason: input.reason.slice(0, 500),
      now,
    },
  );
}

export async function publishProjectKnowledgeDraft(input: {
  scope: ProjectScope;
  actor: string;
  draftId: string;
  publicationIntent?: ProjectKnowledgePublicationIntent;
}) {
  const scope = assertProjectScope(input.scope);
  const publicationIntent = input.publicationIntent ?? "human_reviewed";
  const result = await withTransaction(async (client) => {
    await acquireProjectKnowledgeLock(scope, client);
    await backfillProjectKnowledgeCompilerFoundation(scope, client);
    const draft = await getDraftRow(scope, input.draftId, client, true);
    if (!draft) return { kind: "not_found" as const };
    if (draft.status === "published") return { kind: "published" as const, draft: toDraft(draft) };
    if (draft.compiler_contract_version !== PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION) {
      return { kind: "contract_mismatch" as const };
    }
    if (publicationIntent === "human_reviewed" && (draft.status === "blocked" || asArray(draft.blockers_json).length)) {
      return { kind: "blocked" as const };
    }
    if (draft.status !== "ready_for_review") {
      return publicationIntent === "automatic_provenance_refresh"
        ? { kind: "automatic_denied" as const, draft: toDraft(draft) }
        : { kind: "invalid_state" as const, status: draft.status };
    }

    const currentManifest = await loadCurrentProjectKnowledgeSourceManifest(scope, client);
    const currentFingerprint = computeProjectKnowledgeSourceFingerprint(currentManifest);
    const current = await loadCurrentKnowledge(scope, client);
    if (publicationIntent === "automatic_provenance_refresh") {
      const parent = draft.parent_draft_id
        ? await getDraftRow(scope, draft.parent_draft_id, client, true)
        : undefined;
      const childKnowledge = ProjectKnowledgeBaseSchema.parse(draft.proposed_knowledge_json);
      const publishedKnowledge = current
        ? ProjectKnowledgeBaseSchema.parse(JSON.parse(current.validated_output))
        : null;
      const parentKnowledge = parent?.proposed_knowledge_json
        ? ProjectKnowledgeBaseSchema.parse(parent.proposed_knowledge_json)
        : null;
      const decision = current && parent && publishedKnowledge && parentKnowledge &&
          currentFingerprint === draft.source_fingerprint
        ? evaluateAutomaticProvenanceRefresh({
            publishedKnowledgeBase: publishedKnowledge,
            publishedSemanticHash: current.semantic_hash,
            parentKnowledgeBase: parentKnowledge,
            parentSemanticHash: parent.semantic_hash,
            childKnowledgeBase: childKnowledge,
            childSemanticHash: draft.semantic_hash,
            currentActiveRevisionId: current.active_revision_id,
            childBaseRevisionId: draft.base_revision_id,
            childBlockers: asArray(draft.blockers_json),
          })
        : { allowed: false as const, reason: "missing_or_stale_publication_context" };
      if (!decision.allowed) {
        await sqlRun(
          `
            UPDATE project_knowledge_drafts
            SET status = 'ready_for_review', status_reason = 'automatic_publication_denied',
                review_ready_at = COALESCE(review_ready_at, @now), updated_at = @now
            WHERE id = @draftId
          `,
          { draftId: draft.id, now: nowIso() },
          client,
        );
        return { kind: "automatic_denied" as const, draft: await requireDraft(scope, draft.id, client) };
      }
    }
    if (currentFingerprint !== draft.source_fingerprint || (current?.active_revision_id ?? null) !== draft.base_revision_id) {
      const now = nowIso();
      await sqlRun(
        `
          UPDATE project_knowledge_drafts
          SET status = 'rebase_required', status_reason = @reason,
              pending_drift = true, updated_at = @now
          WHERE id = @draftId
        `,
        {
          draftId: draft.id,
          reason: currentFingerprint !== draft.source_fingerprint ? "source_drift" : "active_revision_drift",
          now,
        },
        client,
      );
      return { kind: "stale" as const };
    }

    const knowledgeBase = ProjectKnowledgeBaseSchema.parse(draft.proposed_knowledge_json);
    const hashes = computeProjectKnowledgeHashes(knowledgeBase);
    if (hashes.semanticKnowledgeHash !== draft.semantic_hash || hashes.provenanceHash !== draft.provenance_hash) {
      return { kind: "invalid_payload" as const };
    }
    const now = nowIso();
    const knowledgeBaseId = current?.id ?? createId("pkb");
    const provenanceStatus = wholeKnowledgeProvenanceStatus(knowledgeBase);
    await sqlRun(
      `
        INSERT INTO project_knowledge_base (
          id, project_id, azure_project_id, azure_project_name, azure_organization_url,
          prompt_version, provider, model_name, source_work_item_count, raw_output,
          validated_output, status, error_details, extracted_at, created_at, updated_at,
          source_manifest_json, source_fingerprint, semantic_hash, provenance_hash,
          semantic_hash_version, provenance_hash_version,
          compiler_contract_version, wording_version, freshness_status,
          provenance_status, compiler_compatibility, stale_since, stale_reason_json
        ) VALUES (
          @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
          @promptVersion, @provider, @model, @sourceWorkItemCount, @rawOutput,
          @validatedOutput, 'Success', NULL, @extractedAt, @createdAt, @updatedAt,
          @sourceManifestJson, @sourceFingerprint, @semanticHash, @provenanceHash,
          @semanticHashVersion, @provenanceHashVersion,
          @compilerContractVersion, @wordingVersion, 'current',
          @provenanceStatus, 'current', NULL, '[]'::jsonb
        )
        ON CONFLICT (project_id, azure_project_id) DO UPDATE SET
          azure_project_name = EXCLUDED.azure_project_name,
          azure_organization_url = EXCLUDED.azure_organization_url,
          prompt_version = EXCLUDED.prompt_version,
          provider = EXCLUDED.provider,
          model_name = EXCLUDED.model_name,
          source_work_item_count = EXCLUDED.source_work_item_count,
          raw_output = EXCLUDED.raw_output,
          validated_output = EXCLUDED.validated_output,
          status = EXCLUDED.status,
          error_details = NULL,
          extracted_at = EXCLUDED.extracted_at,
          updated_at = EXCLUDED.updated_at,
          source_manifest_json = EXCLUDED.source_manifest_json,
          source_fingerprint = EXCLUDED.source_fingerprint,
          semantic_hash = EXCLUDED.semantic_hash,
          provenance_hash = EXCLUDED.provenance_hash,
          semantic_hash_version = EXCLUDED.semantic_hash_version,
          provenance_hash_version = EXCLUDED.provenance_hash_version,
          compiler_contract_version = EXCLUDED.compiler_contract_version,
          wording_version = EXCLUDED.wording_version,
          freshness_status = 'current',
          provenance_status = EXCLUDED.provenance_status,
          compiler_compatibility = 'current',
          stale_since = NULL,
          stale_reason_json = '[]'::jsonb
      `,
      {
        id: knowledgeBaseId,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
        azureOrganizationUrl: scope.azureOrganizationUrl,
        promptVersion: draft.wording_version,
        provider: draft.provider,
        model: draft.model_name,
        sourceWorkItemCount: currentManifest.length,
        rawOutput: draft.raw_output,
        validatedOutput: JSON.stringify(knowledgeBase),
        extractedAt: now,
        createdAt: now,
        updatedAt: now,
        sourceManifestJson: JSON.stringify(currentManifest),
        sourceFingerprint: currentFingerprint,
        semanticHash: hashes.semanticKnowledgeHash,
        provenanceHash: hashes.provenanceHash,
        semanticHashVersion: PROJECT_KNOWLEDGE_SEMANTIC_HASH_VERSION,
        provenanceHashVersion: PROJECT_KNOWLEDGE_PROVENANCE_HASH_VERSION,
        compilerContractVersion: draft.compiler_contract_version,
        wordingVersion: draft.wording_version,
        provenanceStatus,
      },
      client,
    );

    const revision = await recordProjectKnowledgeRevision({
      scope,
      knowledgeBaseId,
      knowledgeBase,
      provider: draft.provider,
      model: draft.model_name,
      rawOutput: draft.raw_output,
      sourceWorkItemCount: currentManifest.length,
      mode: draft.compilation_mode,
      sourceChangeSummary: {
        draftId: draft.id,
        operationCount: asArray(draft.operations_json).length,
      },
      baseRevisionId: draft.base_revision_id,
      sourceManifest: currentManifest,
      sourceFingerprint: currentFingerprint,
      compilerContractVersion: draft.compiler_contract_version,
      wordingVersion: draft.wording_version,
      metrics: {
        ...asRecord(draft.metrics_json),
        reviewDurationMs: draft.review_ready_at
          ? Math.max(0, Date.parse(now) - Date.parse(draft.review_ready_at))
          : null,
      },
    }, client);

    await refreshProjectKnowledgeSearchIndex({ scope, knowledgeBaseId, knowledgeBase }, client);
    await sqlRun(
      `UPDATE project_knowledge_base SET active_revision_id = @revisionId WHERE id = @knowledgeBaseId`,
      { revisionId: revision.revisionId, knowledgeBaseId },
      client,
    );
    await sqlRun(
      `
        UPDATE project_knowledge_drafts
        SET status = 'published', status_reason = NULL, published_at = @now, updated_at = @now
        WHERE id = @draftId
      `,
      { draftId: draft.id, now },
      client,
    );
    await sqlRun(
      `
        WITH RECURSIVE ancestors AS (
          SELECT parent_draft_id FROM project_knowledge_drafts WHERE id = @draftId
          UNION ALL
          SELECT drafts.parent_draft_id
          FROM project_knowledge_drafts drafts
          JOIN ancestors ON drafts.id = ancestors.parent_draft_id
          WHERE ancestors.parent_draft_id IS NOT NULL
        )
        UPDATE project_knowledge_drafts
        SET status = 'superseded', status_reason = 'descendant_published', updated_at = @now
        WHERE id IN (SELECT parent_draft_id FROM ancestors WHERE parent_draft_id IS NOT NULL)
          AND status <> 'published'
      `,
      { draftId: draft.id, now },
      client,
    );
    await writeAuditLogTransactional({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_knowledge_revision",
      entityId: revision.revisionId,
      action: "rag.knowledge_draft.published",
      status: "Success",
      actor: input.actor,
      message: `Published project knowledge revision ${revision.revisionNumber}.`,
      details: { draftId: draft.id, revisionNumber: revision.revisionNumber },
    }, client);
    return { kind: "success" as const, knowledgeBaseId, revision, draftId: draft.id };
  });

  if (result.kind === "not_found") throw draftNotFound();
  if (result.kind === "stale") throw staleDraftError();
  if (result.kind === "blocked") throw publicationBlocked();
  if (result.kind === "contract_mismatch") throw contractMismatch();
  if (result.kind === "invalid_payload") {
    throw new AppError({
      code: AppErrorCode.KnowledgePublicationBlocked,
      message: "Draft hashes do not match the persisted proposal.",
      userMessage: "The draft failed integrity validation. Regenerate it before publishing.",
    });
  }
  if (result.kind === "invalid_state") throw draftStateConflict(result.status);
  if (result.kind === "published") return result.draft;
  if (result.kind === "automatic_denied") return result.draft;

  try {
    await runProjectKnowledgeLint({ scope });
  } catch (error) {
    console.error("Project knowledge lint failed after draft publication", error);
  }
  return getProjectKnowledgeDraft({ scope, draftId: result.draftId });
}

export async function tryDeterministicProjectKnowledgeRebase(input: {
  scope: ProjectScope;
  actor: string;
  parentDraftId: string;
}) {
  const scope = assertProjectScope(input.scope);
  try {
    return await withTransaction(async (client) => {
    await acquireProjectKnowledgeLock(scope, client);
    const parent = await getDraftRow(scope, input.parentDraftId, client, true);
    if (!parent) throw draftNotFound();
    if (parent.status !== "rebase_required") throw draftStateConflict(parent.status);
    if (parent.rebase_depth >= PROJECT_KNOWLEDGE_MAX_REBASE_DEPTH) {
      return { kind: "full_preview_required" as const, reason: "depth_limit" as const };
    }
    const currentManifest = await loadCurrentProjectKnowledgeSourceManifest(scope, client);
    const currentFingerprint = computeProjectKnowledgeSourceFingerprint(currentManifest);
    if (currentFingerprint !== parent.source_fingerprint) {
      return { kind: "generation_required" as const, reason: "source_drift" as const };
    }
    const current = await loadCurrentKnowledge(scope, client);
    if (!current || current.active_revision_id === parent.base_revision_id) {
      return { kind: "generation_required" as const, reason: "no_revision_delta" as const };
    }
    const parentKnowledge = parent.proposed_knowledge_json
      ? ProjectKnowledgeBaseSchema.parse(parent.proposed_knowledge_json)
      : null;
    if (!parentKnowledge) return { kind: "generation_required" as const, reason: "missing_proposal" as const };
    const latestKnowledge = ProjectKnowledgeBaseSchema.parse(JSON.parse(current.validated_output));
    const latestVersions = await loadActiveEntryVersions(scope, client);
    const operations = asArray(parent.operations_json) as ProjectKnowledgeOperation[];
    const expectedVersionIds = operations
      .map((operation) => operation.expectedEntryVersionId)
      .filter((value): value is string => Boolean(value));
    const versionHistory = expectedVersionIds.length
      ? await sqlAll<{
          category: string;
          entry_key: string;
          id: string;
          entry_semantic_hash: string | null;
          status: string;
        }>(
          `
            SELECT category, entry_key, id, entry_semantic_hash, status
            FROM project_knowledge_entry_versions
            WHERE project_id = @projectId AND azure_project_id = @azureProjectId
              AND id = ANY(@versionIds::text[])
          `,
          {
            projectId: scope.projectId,
            azureProjectId: scope.azureProjectId,
            versionIds: expectedVersionIds,
          },
          client,
        ).then((rows) => rows.filter((row) => row.entry_semantic_hash).map((row) => ({
          category: row.category,
          entryKey: row.entry_key,
          entryVersionId: row.id,
          entrySemanticHash: row.entry_semantic_hash!,
          status: row.status,
        })))
      : [];
    const generationData = asRecord(parent.generation_data_json);
    const baseKnowledge = generationData.baseKnowledgeBase
      ? ProjectKnowledgeBaseSchema.parse(generationData.baseKnowledgeBase)
      : null;
    const currentConflictParticipants: Record<string, Array<Record<string, unknown>>> = {};
    for (const conflict of detectProjectKnowledgeHardConflicts(latestKnowledge)) {
      currentConflictParticipants[conflict.subject] = conflict.participants;
      currentConflictParticipants[conflict.identityKey] = conflict.participants;
    }
    const replay = replayProjectKnowledgeOperations({
      baseKnowledgeBase: baseKnowledge,
      latestKnowledgeBase: latestKnowledge,
      operations,
      latestVersions,
      versionHistory,
      currentContradictionParticipants: currentConflictParticipants,
    });
    const proposedKnowledge = replay.knowledgeBase ?? parentKnowledge;
    const mergedConflicts = detectProjectKnowledgeHardConflicts(proposedKnowledge);
    const hashes = computeProjectKnowledgeHashes(proposedKnowledge);
    const nextOperations = replay.knowledgeBase
      ? buildProjectKnowledgeOperations({
          baseKnowledgeBase: latestKnowledge,
          proposedKnowledgeBase: proposedKnowledge,
          baseVersions: latestVersions,
        })
      : operations;
    nextOperations.push(...hardConflictOperations(mergedConflicts));
    const replayBlockers = replay.failed.map((outcome) => {
      const entryInstanceId = projectKnowledgeEntryInstanceId({
        category: outcome.operation.category,
        entryKey: outcome.operation.entryKey,
        projection: outcome.proposed ?? outcome.latest ?? outcome.base,
        provenance: { operationId: outcome.operation.id, result: outcome.result },
      });
      return {
        id: projectKnowledgeBlockerId({
          type: "replay_conflict",
          category: outcome.operation.category,
          entryKey: outcome.operation.entryKey,
          entryInstanceId,
          operationId: outcome.operation.id,
        }),
        type: "replay_conflict",
        category: outcome.operation.category,
        entryKey: outcome.operation.entryKey,
        entryInstanceId,
        message: "The published entry changed after this draft was prepared. Choose the value to keep.",
        operationId: outcome.operation.id,
        result: outcome.result,
        base: outcome.base,
        latest: outcome.latest,
        proposed: outcome.proposed,
        actions: ["keep_latest", "use_proposed", "edit_proposed"],
      };
    });
    const hardConflictBlockers = buildHardConflictBlockers(mergedConflicts);
    const blockers = normalizeProjectKnowledgeBlockers([...replayBlockers, ...hardConflictBlockers]);
    const childStatus: ProjectKnowledgeDraftStatus = blockers.length ? "blocked" : "ready_for_review";
    const childStatusReason = mergedConflicts.length
      ? "hard_conflict"
      : replay.failed.length
        ? "replay_conflict"
        : "revision_replayed";
    const now = nowIso();
    const childId = createId("pkd");
    await sqlRun(
      `
        INSERT INTO project_knowledge_drafts (
          id, workspace_id, project_id, azure_project_id, azure_project_name,
          azure_organization_url, generation_mode, compilation_mode, status,
          status_reason, parent_draft_id, rebase_depth, base_revision_id,
          source_manifest_json, source_fingerprint, compiler_contract_version,
          wording_version, provider, model_name, raw_output,
          proposed_knowledge_json, operations_json, generation_data_json,
          blockers_json, metrics_json, semantic_hash, provenance_hash,
          pending_drift, heartbeat_at, review_ready_at, created_by, created_at, updated_at
        ) VALUES (
          @id, (SELECT workspace_id FROM projects WHERE id = @projectId), @projectId,
          @azureProjectId, @azureProjectName, @azureOrganizationUrl, @generationMode,
          @compilationMode, @status, @statusReason, @parentDraftId,
          @rebaseDepth, @baseRevisionId, @sourceManifestJson, @sourceFingerprint,
          @compilerContractVersion, @wordingVersion, @provider, @model,
          @rawOutput, @proposedKnowledgeJson, @operationsJson, @generationDataJson,
          @blockersJson, @metricsJson, @semanticHash, @provenanceHash,
          false, @heartbeatAt, @reviewReadyAt, @createdBy, @createdAt, @updatedAt
        )
      `,
      {
        id: childId,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
        azureOrganizationUrl: scope.azureOrganizationUrl,
        generationMode: parent.generation_mode,
        compilationMode: parent.compilation_mode,
        status: childStatus,
        statusReason: childStatusReason,
        parentDraftId: parent.id,
        rebaseDepth: parent.rebase_depth + 1,
        baseRevisionId: current.active_revision_id,
        sourceManifestJson: JSON.stringify(currentManifest),
        sourceFingerprint: currentFingerprint,
        compilerContractVersion: PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
        wordingVersion: PROJECT_KNOWLEDGE_WORDING_VERSION,
        provider: parent.provider,
        model: parent.model_name,
        rawOutput: parent.raw_output,
        proposedKnowledgeJson: JSON.stringify(proposedKnowledge),
        operationsJson: JSON.stringify(nextOperations),
        generationDataJson: JSON.stringify({ baseKnowledgeBase: latestKnowledge, baseVersions: latestVersions }),
        blockersJson: JSON.stringify(blockers),
        metricsJson: JSON.stringify({
          ...asRecord(parent.metrics_json),
          rebaseCount: Number(asRecord(parent.metrics_json).rebaseCount ?? 0) + 1,
          replayConflictCount: replay.failed.length,
          conflictCount: mergedConflicts.length,
        }),
        semanticHash: hashes.semanticKnowledgeHash,
        provenanceHash: hashes.provenanceHash,
        heartbeatAt: now,
        reviewReadyAt: now,
        createdBy: input.actor,
        createdAt: now,
        updatedAt: now,
      },
      client,
    );
    await persistProjectKnowledgeHardConflicts(scope, childId, mergedConflicts, now, client);
    await writeAuditLogTransactional({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_knowledge_draft",
      entityId: childId,
      action: "rag.knowledge_draft.rebased",
      status: replay.failed.length || mergedConflicts.length ? "Partial failure" : "Success",
      actor: input.actor,
      message: replay.failed.length
        ? "Replayed a knowledge draft with conflicts requiring three-way review."
        : mergedConflicts.length
          ? "Replayed a knowledge draft and blocked it on merged hard conflicts."
        : "Replayed a knowledge draft against the latest published revision.",
      details: {
        parentDraftId: parent.id,
        replayConflictCount: replay.failed.length,
        hardConflictCount: mergedConflicts.length,
      },
    }, client);
    return { kind: "replayed" as const, draft: await requireDraft(scope, childId, client) };
    });
  } catch (error) {
    if (isLiveChildUniqueViolation(error)) throw liveChildConflict();
    throw error;
  }
}

export async function resolveProjectKnowledgeDraft(input: {
  scope: ProjectScope;
  actor: string;
  draftId: string;
  proposedKnowledge: ProjectKnowledgeBase;
}) {
  const scope = assertProjectScope(input.scope);
  const draft = await getProjectKnowledgeDraft({ scope, draftId: input.draftId });
  if (!draft) throw draftNotFound();
  if (!["ready_for_review", "blocked"].includes(draft.persistedStatus)) {
    throw draftStateConflict(draft.persistedStatus);
  }
  const resolved = await completeProjectKnowledgeDraft({
    scope,
    draftId: draft.id,
    provider: draft.provider ?? "reviewer",
    model: draft.model ?? "reviewer-edited",
    rawOutput: draft.rawOutput ?? JSON.stringify(input.proposedKnowledge),
    knowledgeBase: input.proposedKnowledge,
    recoverMissingEvidenceRefs: false,
    metrics: {
      ...draft.metrics,
      manualResolutionCount: Number(draft.metrics.manualResolutionCount ?? 0) + 1,
    },
  });
  return resolved;
}

export async function getProjectKnowledgeDraft(input: { scope: ProjectScope; draftId: string }) {
  const scope = assertProjectScope(input.scope);
  await expireManualProjectKnowledgeDrafts(scope);
  const row = await getDraftRow(scope, input.draftId);
  return row ? toDraft(row) : null;
}

export async function getProjectKnowledgeDraftReviewContext(input: {
  scope: ProjectScope;
  draftId: string;
}): Promise<ProjectKnowledgeReviewContext | null> {
  const scope = assertProjectScope(input.scope);
  const row = await getDraftRow(scope, input.draftId);
  if (!row) return null;
  const knowledgeBase = row.proposed_knowledge_json
    ? ProjectKnowledgeBaseSchema.parse(row.proposed_knowledge_json)
    : null;
  if (!knowledgeBase) return { entries: [], sources: [] };
  const blockers = normalizeProjectKnowledgeBlockers(asArray(row.blockers_json));
  const sourceBlockers = blockers.filter((blocker) =>
    blocker.type !== "replay_conflict" && blocker.type !== "hard_conflict");
  const reviewableEntries = reviewableKnowledgeEntries(knowledgeBase);
  const entriesByInstanceId = new Map(reviewableEntries.map((entry) => [entry.entryInstanceId, entry]));
  const sourceTargets = new Map<string, {
    category: Exclude<ProjectKnowledgeDraftBlocker["category"], "hard_conflict">;
    entryKey: string;
    entryInstanceId: string;
    value?: (typeof reviewableEntries)[number]["value"];
    blockers: typeof sourceBlockers;
  }>();
  for (const blocker of sourceBlockers) {
    const exactEntry = blocker.entryInstanceId
      ? entriesByInstanceId.get(blocker.entryInstanceId)
      : undefined;
    const logicalMatches = exactEntry ? [] : reviewableEntries.filter((entry) =>
      entry.category === blocker.category && entry.entryKey === canonicalReviewKey(blocker.entryKey));
    const entry = exactEntry ?? (logicalMatches.length === 1 ? logicalMatches[0] : undefined);
    const targetKey = entry?.entryInstanceId ?? blocker.entryInstanceId ?? blocker.id;
    const existing = sourceTargets.get(targetKey);
    if (existing) {
      existing.blockers.push(blocker);
      continue;
    }
    sourceTargets.set(targetKey, {
      category: blocker.category as Exclude<ProjectKnowledgeDraftBlocker["category"], "hard_conflict">,
      entryKey: entry?.entryKey ?? canonicalReviewKey(blocker.entryKey),
      entryInstanceId: targetKey,
      ...(entry ? { value: entry.value } : {}),
      blockers: [blocker],
    });
  }
  const hardConflictBlockers = blockers.filter((blocker) => blocker.type === "hard_conflict");
  if (!sourceTargets.size && !hardConflictBlockers.length) return { entries: [], sources: [] };

  const referencedSnapshotIds = new Set<string>();
  const referencedWorkItemIds = new Set<string>();
  for (const blocker of blockers) {
    if (blocker.type === "replay_conflict") continue;
    if (blocker.type === "hard_conflict") {
      for (const participant of blocker.participants) {
        for (const snapshotId of participant.sourceSnapshotIds ?? []) referencedSnapshotIds.add(snapshotId);
        for (const workItemId of participant.sourceWorkItemIds ?? []) referencedWorkItemIds.add(workItemId);
        for (const ref of participant.evidenceRefs ?? []) {
          referencedSnapshotIds.add(ref.sourceSnapshotId);
          referencedWorkItemIds.add(ref.sourceWorkItemId);
        }
      }
      continue;
    }
    for (const workItemId of blocker.sourceWorkItemIds) referencedWorkItemIds.add(workItemId);
    if ("sourceSnapshotId" in blocker && blocker.sourceSnapshotId) {
      referencedSnapshotIds.add(blocker.sourceSnapshotId);
    }
  }
  const manifest = ProjectKnowledgeSourceManifestSchema.parse(asArray(row.source_manifest_json));
  const relevantManifest = manifest.filter((entry) =>
    referencedSnapshotIds.has(entry.sourceSnapshotId) || referencedWorkItemIds.has(entry.sourceWorkItemId));
  for (const entry of relevantManifest) referencedSnapshotIds.add(entry.sourceSnapshotId);
  // Only blocker-referenced snapshots are serialized to the client; the wider pool
  // loaded below for suggestion search stays server-side.
  const displaySnapshotIds = new Set(referencedSnapshotIds);
  // Guided re-anchor needs the whole manifest pool: an entry's legacy evidence may
  // only exist in a source the LLM never cited, and the suggestion search is gated
  // on uniqueness across every loadable snapshot of this draft.
  const wantsEvidenceSuggestions = Array.from(sourceTargets.values())
    .some((target) => target.value && !target.value.evidenceRefs?.length);
  if (wantsEvidenceSuggestions) {
    for (const entry of manifest) referencedSnapshotIds.add(entry.sourceSnapshotId);
  }
  const snapshots = await loadEvidenceSnapshotsByIds(scope, Array.from(referencedSnapshotIds));
  // Suggestions must anchor only to the draft's frozen manifest — a blocker-referenced
  // snapshot can be superseded content the current source contradicts.
  const manifestSnapshotIds = new Set(manifest.map((entry) => entry.sourceSnapshotId));
  const suggestionSnapshots = snapshots.filter((snapshot) => manifestSnapshotIds.has(snapshot.id));
  const manifestBySnapshotId = new Map(manifest.map((entry) => [entry.sourceSnapshotId, entry]));
  const reviewSource = (
    snapshot: ProjectKnowledgeEvidenceSnapshot,
    allowedFields: readonly ProjectKnowledgeEvidenceRef["sourceField"][] = PROJECT_KNOWLEDGE_SOURCE_FIELDS,
  ) => {
    const metadata = manifestBySnapshotId.get(snapshot.id);
    return {
      sourceSnapshotId: snapshot.id,
      sourceWorkItemId: snapshot.sourceWorkItemId,
      workItemType: metadata?.workItemType ?? "Work item",
      workItemTitle: reviewSourceFieldText(snapshot.fields, "title") || `Work item ${snapshot.sourceWorkItemId}`,
      workItemUrl: buildAzureWorkItemUrl(scope, snapshot.sourceWorkItemId),
      adoRevision: metadata?.adoRevision ?? null,
      sourceUpdatedAt: metadata?.sourceUpdatedAt ?? null,
      capturedAt: metadata?.capturedAt ?? null,
      fields: allowedFields.flatMap((sourceField) => {
        const text = reviewSourceFieldText(snapshot.fields, sourceField);
        return text ? [{ sourceField, text }] : [];
      }),
    };
  };
  return {
    entries: Array.from(sourceTargets.values()).map((target) => {
      const allowedFields = target.category === "business_rule"
        ? PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS
        : PROJECT_KNOWLEDGE_SOURCE_FIELDS;
      const affectedWorkItemIds = new Set([
        ...(target.value?.sourceWorkItemIds ?? []),
        ...(target.value?.evidenceRefs ?? []).map((ref) => ref.sourceWorkItemId),
        ...target.blockers.flatMap((blocker) => blocker.sourceWorkItemIds),
      ].filter(Boolean));
      const expectedSnapshotIds = new Set([
        ...(target.value?.evidenceRefs ?? []).map((ref) => ref.sourceSnapshotId),
        ...target.blockers.flatMap((blocker) =>
          "sourceSnapshotId" in blocker && blocker.sourceSnapshotId ? [blocker.sourceSnapshotId] : []),
      ]);
      for (const manifestEntry of manifest) {
        if (affectedWorkItemIds.has(manifestEntry.sourceWorkItemId)) {
          expectedSnapshotIds.add(manifestEntry.sourceSnapshotId);
        }
      }
      const matchingSnapshots = snapshots.filter((snapshot) =>
        affectedWorkItemIds.size
          ? affectedWorkItemIds.has(snapshot.sourceWorkItemId)
          : expectedSnapshotIds.has(snapshot.id));
      const sources = matchingSnapshots.map((snapshot) => reviewSource(snapshot, allowedFields));
      const missingExpectedSnapshot = Array.from(expectedSnapshotIds)
        .some((snapshotId) => !snapshots.some((snapshot) => snapshot.id === snapshotId));
      const sourceAvailability = sources.some((source) => source.fields.length)
        ? "available" as const
        : sources.length
          ? "empty_fields" as const
          : missingExpectedSnapshot
            ? "snapshot_missing" as const
            : "unmatched_work_item" as const;
      const suggestedEvidence = target.value && !target.value.evidenceRefs?.length
        ? suggestEvidenceAnchors(target.value.evidence, suggestionSnapshots, allowedFields)
        : undefined;
      return {
        category: target.category,
        entryKey: target.entryKey,
        entryInstanceId: target.entryInstanceId,
        sourceAvailability,
        affectedWorkItemIds: Array.from(affectedWorkItemIds).sort(),
        sources,
        ...(suggestedEvidence ? { suggestedEvidence } : {}),
      };
    }),
    sources: snapshots
      .filter((snapshot) => displaySnapshotIds.has(snapshot.id))
      .map((snapshot) => reviewSource(snapshot)),
  };
}

// A suggestion is offered only when EVERY legacy evidence fragment anchors uniquely
// somewhere in the draft's snapshot pool — one accepted suggestion fully resolves the
// blocker. Partial matches stay manual so the reviewer never publishes half-anchored
// evidence without seeing it.
function suggestEvidenceAnchors(
  evidence: string,
  snapshots: ProjectKnowledgeEvidenceSnapshot[],
  allowedFields: readonly ProjectKnowledgeEvidenceRef["sourceField"][],
) {
  const fragments = splitProjectKnowledgeLegacyEvidence(evidence);
  if (!fragments.length) return undefined;
  const anchors = fragments.map((fragment) =>
    findUniqueProjectKnowledgeEvidenceAnchor(snapshots, allowedFields, fragment));
  if (anchors.some((anchor) => !anchor)) return undefined;
  return anchors.map((anchor) => ({
    sourceSnapshotId: anchor!.sourceSnapshotId,
    sourceWorkItemId: anchor!.sourceWorkItemId,
    sourceField: anchor!.sourceField,
    quote: anchor!.quote,
    verification: anchor!.verification,
  }));
}

function buildAzureWorkItemUrl(scope: ProjectScope, workItemId: string) {
  const organizationUrl = scope.azureOrganizationUrl.replace(/\/+$/, "");
  return `${organizationUrl}/${encodeURIComponent(scope.azureProjectName)}/_workitems/edit/${encodeURIComponent(workItemId)}`;
}

export async function abandonProjectKnowledgeDraft(input: {
  scope: ProjectScope;
  actor: string;
  draftId: string;
}) {
  const scope = assertProjectScope(input.scope);
  return withTransaction(async (client) => {
    await acquireProjectKnowledgeLock(scope, client);
    await expireManualProjectKnowledgeDrafts(scope, client);
    const draft = await getDraftRow(scope, input.draftId, client, true);
    if (!draft) throw draftNotFound();
    if (!["generating", "awaiting_input", "ready_for_review", "blocked", "rebase_required"].includes(draft.status)) {
      throw draftStateConflict(draft.status);
    }
    const now = nowIso();
    await sqlRun(
      `
        UPDATE project_knowledge_drafts
        SET status = 'superseded', status_reason = 'abandoned_by_user', updated_at = @now
        WHERE id = @draftId
      `,
      { draftId: draft.id, now },
      client,
    );
    await writeAuditLogTransactional({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_knowledge_draft",
      entityId: draft.id,
      action: "rag.knowledge_draft.abandoned",
      status: "Success",
      actor: input.actor,
      message: "Abandoned a project knowledge draft.",
      details: { previousStatus: draft.status },
    }, client);
    return requireDraft(scope, draft.id, client);
  });
}

export async function listProjectKnowledgeDrafts(input: { scope: ProjectScope; limit?: number }) {
  const scope = assertProjectScope(input.scope);
  await expireManualProjectKnowledgeDrafts(scope);
  const rows = await sqlAll<DraftRow>(
    `
      SELECT * FROM project_knowledge_drafts
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      limit: Math.min(100, Math.max(1, input.limit ?? 30)),
    },
  );
  return rows.map(toDraft);
}


export async function markProjectKnowledgeSourceDrift(
  scopeInput: ProjectScope,
  reason: Record<string, unknown>,
  client: PoolClient,
) {
  const scope = assertProjectScope(scopeInput);
  const now = nowIso();
  await sqlRun(
    `
      UPDATE project_knowledge_base
      SET freshness_status = 'stale', stale_since = COALESCE(stale_since, @now),
          stale_reason_json = @reasonJson, updated_at = @now
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      now,
      reasonJson: JSON.stringify([reason]),
    },
    client,
  );
  await sqlRun(
    `
      UPDATE project_knowledge_drafts
      SET pending_drift = true,
          status = CASE
            WHEN status IN ('awaiting_input', 'ready_for_review') THEN 'rebase_required'
            ELSE status
          END,
          status_reason = CASE
            WHEN status IN ('awaiting_input', 'ready_for_review') THEN 'source_drift'
            ELSE status_reason
          END,
          updated_at = @now
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND status IN ('generating', 'awaiting_input', 'ready_for_review')
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId, now },
    client,
  );
}

export async function loadCurrentProjectKnowledgeSourceManifest(
  scopeInput: ProjectScope,
  client?: PoolClient,
) {
  const scope = assertProjectScope(scopeInput);
  const rows = await sqlAll<SourceManifestRow>(
    `
      SELECT snapshots.id AS source_snapshot_id,
             snapshots.azure_work_item_id AS source_work_item_id,
             snapshots.work_item_type, snapshots.content_hash,
             snapshots.ado_revision, snapshots.source_updated_at, snapshots.captured_at
      FROM azure_devops_work_items work_items
      JOIN azure_devops_work_item_snapshots snapshots
        ON snapshots.id = work_items.current_snapshot_id
      WHERE work_items.project_id = @projectId
        AND work_items.azure_project_id = @azureProjectId
        AND COALESCE(work_items.sync_status, 'active') = 'active'
      ORDER BY snapshots.azure_work_item_id, snapshots.id
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    client,
  );
  return ProjectKnowledgeSourceManifestSchema.parse(rows.map((row) => ({
    sourceSnapshotId: row.source_snapshot_id,
    sourceWorkItemId: row.source_work_item_id,
    workItemType: row.work_item_type,
    contentHash: row.content_hash,
    adoRevision: row.ado_revision,
    sourceUpdatedAt: row.source_updated_at,
    capturedAt: row.captured_at,
  })));
}

async function loadCurrentKnowledge(scope: ProjectScope, client?: PoolClient) {
  return sqlGet<CurrentKnowledgeRow>(
    `
      SELECT id, active_revision_id, validated_output, semantic_hash, provenance_hash
      FROM project_knowledge_base
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
      LIMIT 1
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    client,
  );
}

async function loadActiveEntryVersions(scope: ProjectScope, client?: PoolClient) {
  const rows = await sqlAll<{
    category: string;
    entry_key: string;
    id: string;
    entry_semantic_hash: string | null;
    status: string;
  }>(
    `
      SELECT category, entry_key, id, entry_semantic_hash, status
      FROM project_knowledge_entry_versions
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND status = 'active'
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    client,
  );
  return rows
    .filter((row) => row.entry_semantic_hash)
    .map((row) => ({
      category: row.category,
      entryKey: row.entry_key,
      entryVersionId: row.id,
      entrySemanticHash: row.entry_semantic_hash!,
      status: row.status,
    }));
}

async function loadEvidenceSnapshots(
  scope: ProjectScope,
  knowledgeBase: ProjectKnowledgeBase,
  sourceManifest: ProjectKnowledgeSourceManifestEntry[] = [],
  client?: PoolClient,
) {
  const snapshotIds = Array.from(new Set([
    ...allEvidenceRefs(knowledgeBase).map((ref) => ref.sourceSnapshotId),
    ...sourceManifest.map((entry) => entry.sourceSnapshotId),
  ]));
  return loadEvidenceSnapshotsByIds(scope, snapshotIds, client);
}

async function loadEvidenceSnapshotsByIds(
  scope: ProjectScope,
  snapshotIds: string[],
  client?: PoolClient,
) {
  if (!snapshotIds.length) return [];
  const rows = await sqlAll<EvidenceSnapshotRow>(
    `
      SELECT id, azure_work_item_id, fields_json
      FROM azure_devops_work_item_snapshots
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND id = ANY(@snapshotIds::text[])
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId, snapshotIds },
    client,
  );
  return rows.map((row): ProjectKnowledgeEvidenceSnapshot => ({
    id: row.id,
    sourceWorkItemId: row.azure_work_item_id,
    fields: asRecord(row.fields_json),
  }));
}

async function getDraftRow(
  scope: ProjectScope,
  draftId: string,
  client?: PoolClient,
  forUpdate = false,
) {
  return sqlGet<DraftRow>(
    `
      SELECT * FROM project_knowledge_drafts
      WHERE id = @draftId AND project_id = @projectId AND azure_project_id = @azureProjectId
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    { draftId, projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    client,
  );
}

async function requireDraft(scope: ProjectScope, draftId: string, client?: PoolClient) {
  const row = await getDraftRow(scope, draftId, client);
  if (!row) throw draftNotFound();
  return toDraft(row);
}

async function expireManualProjectKnowledgeDrafts(scope: ProjectScope, client?: PoolClient) {
  const cutoff = new Date(Date.now() - PROJECT_KNOWLEDGE_MANUAL_DRAFT_TTL_MS).toISOString();
  const now = nowIso();
  await sqlRun(
    `
      UPDATE project_knowledge_drafts
      SET status = 'superseded', status_reason = 'manual_draft_expired', updated_at = @now
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND generation_mode = 'manual'
        AND status IN ('generating', 'awaiting_input', 'ready_for_review', 'blocked', 'rebase_required')
        AND updated_at < @cutoff
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId, cutoff, now },
    client,
  );
}

function toDraft(row: DraftRow): ProjectKnowledgeDraft {
  const manifest = ProjectKnowledgeSourceManifestSchema.parse(asArray(row.source_manifest_json));
  const proposedKnowledge = row.proposed_knowledge_json
    ? ProjectKnowledgeBaseSchema.parse(row.proposed_knowledge_json)
    : null;
  const blockers = normalizeProjectKnowledgeBlockers(asArray(row.blockers_json));
  const metrics = asRecord(row.metrics_json);
  return {
    id: row.id,
    generationMode: row.generation_mode,
    compilationMode: row.compilation_mode,
    status: displayProjectKnowledgeDraftStatus(row.status, row.heartbeat_at),
    persistedStatus: row.status,
    statusReason: row.status_reason,
    parentDraftId: row.parent_draft_id,
    rebaseDepth: row.rebase_depth,
    baseRevisionId: row.base_revision_id,
    sourceManifest: manifest,
    sourceFingerprint: row.source_fingerprint,
    compilerContractVersion: row.compiler_contract_version,
    regenerateRequired: row.compiler_contract_version !== PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
    wordingVersion: row.wording_version,
    provider: row.provider,
    model: row.model_name,
    rawOutput: row.raw_output,
    proposedKnowledge,
    knowledgeBase: proposedKnowledge,
    operations: asArray(row.operations_json) as ProjectKnowledgeOperation[],
    blockers,
    reviewSummary: summarizeProjectKnowledgeReview(blockers, metrics),
    metrics,
    semanticHash: row.semantic_hash,
    provenanceHash: row.provenance_hash,
    pendingDrift: row.pending_drift,
    heartbeatAt: row.heartbeat_at,
    reviewReadyAt: row.review_ready_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

function wholeKnowledgeProvenanceStatus(knowledgeBase: ProjectKnowledgeBase) {
  const refsByEntry = allKnowledgeEntryRefs(knowledgeBase);
  if (refsByEntry.every((refs) => !refs.length)) return "legacy_unknown";
  const statuses = refsByEntry.map(getEntryProvenanceStatus);
  if (statuses.every((status) => status === "verified")) return "verified";
  if (statuses.some((status) => status === "verified" || status === "partial")) return "partial";
  return "legacy_unverified";
}

function allKnowledgeEntryRefs(knowledgeBase: ProjectKnowledgeBase) {
  return [
    ...knowledgeBase.modules.map((entry) => entry.evidenceRefs ?? []),
    ...knowledgeBase.businessRules.map((entry) => entry.evidenceRefs ?? []),
    ...knowledgeBase.stateTransitions.map((entry) => entry.evidenceRefs ?? []),
    ...knowledgeBase.glossary.map((entry) => entry.evidenceRefs ?? []),
    ...knowledgeBase.crossDependencies.map((entry) => entry.evidenceRefs ?? []),
  ];
}

function allEvidenceRefs(knowledgeBase: ProjectKnowledgeBase) {
  return allKnowledgeEntryRefs(knowledgeBase).flat();
}

// Passive pipeline-quality thresholds surfaced in the knowledge health banner.
const PIPELINE_WARNING_DRAFT_WINDOW = 20;
const RESIDUAL_REANCHOR_WARNING_RATE = 0.05;
const EXCESSIVE_SPLIT_CALL_COUNT = 5;
const UNKNOWN_MODEL_FALLBACK_TOKENS = 16_000;

/**
 * Quality alarms computed over the most recent compiled drafts, merged into
 * snapshot.health.warnings by the knowledge status route. Replaces the former
 * governance monitoring checkpoints: same thresholds, but computed at read time
 * with no GA clock and no ADR rows. Quote fidelity is only judged on a full
 * window so a couple of early drafts cannot trip the alarm.
 */
export async function computeProjectKnowledgePipelineWarnings(input: {
  scope: ProjectScope;
}): Promise<string[]> {
  const scope = assertProjectScope(input.scope);
  const rows = await sqlAll<{ metrics_json: unknown }>(
    `
      SELECT metrics_json FROM project_knowledge_drafts
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND compiler_contract_version = @compilerContractVersion
        AND proposed_knowledge_json IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ${PIPELINE_WARNING_DRAFT_WINDOW}
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      compilerContractVersion: PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
    },
  );
  const metrics = rows.map((row) => asRecord(row.metrics_json));
  const warnings: string[] = [];

  if (metrics.length >= PIPELINE_WARNING_DRAFT_WINDOW) {
    const manualReanchors = metrics.reduce((sum, item) => sum + numberMetric(item.manualReanchorCount), 0);
    const verifiedFragments = metrics.reduce(
      (sum, item) => sum + numberMetric(item.quoteExactCount) + numberMetric(item.quoteNormalizedCount) +
        numberMetric(item.quoteAutoReanchorCount) + numberMetric(item.manualReanchorCount),
      0,
    );
    const residualRate = verifiedFragments ? manualReanchors / verifiedFragments : 0;
    if (residualRate > RESIDUAL_REANCHOR_WARNING_RATE) {
      warnings.push(
        `More than ${RESIDUAL_REANCHOR_WARNING_RATE * 100}% of evidence quotes needed manual re-anchoring across the last ${PIPELINE_WARNING_DRAFT_WINDOW} drafts. Check source snapshot quality.`,
      );
    }
  }

  const unknownFallback = metrics.filter((item) => item.inputTokenLimitSource === "unknown_fallback");
  if (unknownFallback.some((item) => numberMetric(item.splitCallCount) >= EXCESSIVE_SPLIT_CALL_COUNT)) {
    warnings.push(
      `Recent drafts used a guessed ${UNKNOWN_MODEL_FALLBACK_TOKENS.toLocaleString("en-US")}-token input limit for an unrecognized model and split extraction heavily. Verify the configured LLM model.`,
    );
  }

  return warnings;
}


function hardConflictOperations(conflicts: ProjectKnowledgeHardConflict[]): ProjectKnowledgeOperation[] {
  return conflicts.map((conflict) => ({
    id: `pkop_${conflict.identityKey.slice(0, 32)}`,
    type: "flag_contradiction",
    category: "hard_conflict",
    entryKey: conflict.identityKey,
    subjectKey: conflict.subject,
    expectedEntryVersionId: null,
    expectedEntrySemanticHash: null,
    proposedEntry: null,
    participants: conflict.participants.map((participant) => ({
      ...participant,
      sourceSnapshotIds: participant.sourceSnapshotIds,
    })),
  }));
}

function buildHardConflictBlockers(conflicts: ProjectKnowledgeHardConflict[]) {
  // Evidence-identical conflicts are wording drift, not source disagreement — order
  // them after the conflicts that need a real decision. Stable within each group.
  return sortProjectKnowledgeHardConflictsForReview(conflicts).map((conflict) => {
    const entryInstanceId = projectKnowledgeEntryInstanceId({
      category: conflict.affectedCategory,
      entryKey: conflict.identityKey,
      projection: {
        subject: conflict.subject,
        conflictType: conflict.conflictType,
        participantSemanticHashes: conflict.participants.map((participant) => participant.semanticHash).sort(),
      },
      provenance: {
        participantIds: conflict.participants.map((participant) => participant.participantId).sort(),
        sourceSnapshotIds: Array.from(new Set(
          conflict.participants.flatMap((participant) => participant.sourceSnapshotIds),
        )).sort(),
      },
    });
    return {
      id: projectKnowledgeBlockerId({
        type: "hard_conflict",
        category: "hard_conflict",
        entryKey: conflict.identityKey,
        entryInstanceId,
        identityKey: conflict.identityKey,
        detailDiscriminator: conflict.conflictType,
      }),
      type: "hard_conflict",
      category: "hard_conflict",
      entryKey: conflict.identityKey,
      entryInstanceId,
      identityKey: conflict.identityKey,
      subject: conflict.subject,
      conflictType: conflict.conflictType,
      affectedCategory: conflict.affectedCategory,
      participants: conflict.participants,
      evidenceIdentical: conflict.evidenceIdentical,
      message: conflict.evidenceIdentical
        ? "These entries cite identical source evidence and differ only in wording. Keep the version that should be published."
        : "These source-backed entries disagree and require a reviewer decision.",
    };
  });
}

function hardConflictParticipantInstanceIds(conflicts: ProjectKnowledgeHardConflict[]) {
  return new Set(conflicts.flatMap((conflict) => conflict.participants.map((participant) =>
    projectKnowledgeEntryInstanceId({
      category: participant.category,
      entryKey: participant.entryKey,
      projection: participant.projection,
      evidence: participant.evidence,
      sourceWorkItemIds: participant.sourceWorkItemIds,
      evidenceRefs: participant.evidenceRefs,
    }))));
}

function hardConflictParticipantIdentities(conflicts: ProjectKnowledgeHardConflict[]) {
  return new Set(conflicts.flatMap((conflict) => conflict.participants.map((participant) =>
    `${participant.category}:${canonicalReviewKey(participant.entryKey)}`)));
}

function buildEvidenceReviewBlockers(
  knowledgeBase: ProjectKnowledgeBase,
  verificationBlockers: ProjectKnowledgeVerificationBlocker[],
  conflicts: ProjectKnowledgeHardConflict[],
) {
  const entries = projectKnowledgeEntryInstances(knowledgeBase);
  const suppressedIdentities = hardConflictParticipantIdentities(conflicts);
  const occurrences = new Map<string, number>();

  return verificationBlockers.flatMap((blocker) => {
    const logicalIdentity = `${blocker.category}:${canonicalReviewKey(blocker.entryKey)}`;
    if (suppressedIdentities.has(logicalIdentity)) return [];

    const candidates = entries.filter((entry) =>
      entry.category === blocker.category && canonicalReviewKey(entry.entryKey) === canonicalReviewKey(blocker.entryKey));
    const matchingCandidateRefs = candidates.flatMap((entry) =>
      (entry.entry.evidenceRefs ?? []).filter((ref) =>
        ref.sourceSnapshotId === blocker.sourceSnapshotId &&
        ref.sourceWorkItemId === blocker.sourceWorkItemId &&
        ref.sourceField === blocker.sourceField)
        .map((ref) => ({
          entryInstanceId: entry.entryInstanceId,
          referenceIdentity: hashCanonicalValue({
            sourceSnapshotId: ref.sourceSnapshotId,
            sourceWorkItemId: ref.sourceWorkItemId,
            sourceField: ref.sourceField,
            quote: ref.quote,
            origin: ref.origin,
          }),
        })));
    const candidateRefs = matchingCandidateRefs.length
      ? matchingCandidateRefs
      : candidates.map((entry) => ({
          entryInstanceId: entry.entryInstanceId,
          referenceIdentity: hashCanonicalValue({
            sourceSnapshotId: blocker.sourceSnapshotId,
            sourceWorkItemId: blocker.sourceWorkItemId,
            sourceField: blocker.sourceField,
          }),
        }));
    const occurrenceKey = [
      logicalIdentity,
      blocker.type,
      blocker.sourceSnapshotId,
      blocker.sourceWorkItemId,
      blocker.sourceField,
    ].join(":");
    const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    const candidate = candidateRefs[occurrence % Math.max(1, candidateRefs.length)];
    const entryInstanceId = candidate?.entryInstanceId ?? projectKnowledgeEntryInstanceId({
      category: blocker.category as ProjectKnowledgeEntryCategory,
      entryKey: blocker.entryKey,
      projection: null,
      provenance: {
        sourceSnapshotId: blocker.sourceSnapshotId,
        sourceWorkItemId: blocker.sourceWorkItemId,
        sourceField: blocker.sourceField,
      },
    });
    const referenceIdentity = candidate?.referenceIdentity ?? hashCanonicalValue({
      sourceSnapshotId: blocker.sourceSnapshotId,
      sourceWorkItemId: blocker.sourceWorkItemId,
      sourceField: blocker.sourceField,
    });
    return [{
      ...blocker,
      id: projectKnowledgeBlockerId({
        ...blocker,
        entryInstanceId,
        referenceIdentity,
        detailDiscriminator: String(occurrence + 1),
      }),
      entryInstanceId,
      referenceIdentity,
      sourceWorkItemIds: [blocker.sourceWorkItemId],
    }];
  });
}

async function persistProjectKnowledgeHardConflicts(
  scope: ProjectScope,
  draftId: string,
  conflicts: ProjectKnowledgeHardConflict[],
  now: string,
  client: PoolClient,
) {
  await sqlRun(
    `DELETE FROM project_knowledge_hard_conflicts WHERE draft_id = @draftId`,
    { draftId },
    client,
  );
  for (const conflict of conflicts) {
    await sqlRun(
      `
        INSERT INTO project_knowledge_hard_conflicts (
          id, workspace_id, project_id, azure_project_id, draft_id, identity_key,
          subject, conflict_type, status, participants_json, created_at, updated_at
        ) VALUES (
          @id, (SELECT workspace_id FROM projects WHERE id = @projectId), @projectId,
          @azureProjectId, @draftId, @identityKey, @subject, @conflictType,
          'open', @participantsJson, @createdAt, @updatedAt
        )
      `,
      {
        id: createId("pkhc"),
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        draftId,
        identityKey: conflict.identityKey,
        subject: conflict.subject,
        conflictType: conflict.conflictType,
        participantsJson: JSON.stringify(conflict.participants),
        createdAt: now,
        updatedAt: now,
      },
      client,
    );
  }
}

// Deliberately strict: only normalization-identical entries merge here. This runs on
// every draft completion, including the resolve/rebase re-check boundary where entries
// reflect explicit reviewer decisions — an evidence-identity paraphrase fallback (see
// shouldAutomaticallyConsolidate in project-knowledge.service.ts) would silently
// override reviewer wording. Compiler-produced paraphrases are merged upstream instead.
function consolidateSafeProjectKnowledgeDuplicates(knowledgeBase: ProjectKnowledgeBase) {
  const modules = consolidateSafeCategory(
    "module",
    knowledgeBase.modules,
    (entry) => canonicalizeProjectKnowledgeLogicalIdentity(entry.id),
    (entry) => comparableProjection(entry.name, entry.description),
  );
  const businessRules = consolidateSafeCategory(
    "business_rule",
    knowledgeBase.businessRules,
    (entry) => canonicalizeProjectKnowledgeLogicalIdentity(entry.id),
    (entry) => comparableProjection(
      entry.rule,
      canonicalizeBusinessRuleSourceFieldForProjection(entry.sourceField),
      entry.moduleName,
    ),
  );
  const stateTransitions = consolidateSafeCategory(
    "state_transition",
    knowledgeBase.stateTransitions,
    (entry) => canonicalizeProjectKnowledgeLogicalIdentity(entry.id),
    (entry) => comparableProjection(
      entry.workflowName,
      entry.fromState,
      entry.toState,
      entry.triggerOrCondition,
      entry.actor,
      entry.moduleName,
    ),
  );
  const glossary = consolidateSafeCategory(
    "glossary",
    knowledgeBase.glossary,
    (entry) => canonicalizeProjectKnowledgeLogicalIdentity(entry.term),
    (entry) => comparableProjection(entry.type, entry.definition),
  );
  const crossDependencies = consolidateSafeCategory(
    "dependency",
    knowledgeBase.crossDependencies,
    (entry) => canonicalizeProjectKnowledgeLogicalIdentity(entry.id),
    (entry) => comparableProjection(
      entry.sourceModule,
      entry.targetModule,
      entry.dependencyType,
      entry.description,
    ),
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
    ].reduce((count, result) => count + result.removedCount, 0),
  };
}

function consolidateSafeCategory<TCategory extends ProjectKnowledgeConsolidationCategory>(
  category: TCategory,
  items: ProjectKnowledgeEntryByConsolidationCategory[TCategory][],
  logicalIdentity: (entry: ProjectKnowledgeEntryByConsolidationCategory[TCategory]) => string,
  normalizedProjection: (entry: ProjectKnowledgeEntryByConsolidationCategory[TCategory]) => string,
) {
  const groups = new Map<string, ProjectKnowledgeEntryByConsolidationCategory[TCategory][]>();
  for (const [index, item] of items.entries()) {
    const identity = logicalIdentity(item);
    const key = identity
      ? JSON.stringify([identity, normalizedProjection(item)])
      : JSON.stringify(["unmergeable-empty-identity", index]);
    const entries = groups.get(key) ?? [];
    entries.push(item);
    groups.set(key, entries);
  }
  const consolidatedItems = Array.from(groups.values()).map((entries) =>
    mergeProjectKnowledgeConflictEntries(category, entries));
  return {
    items: consolidatedItems,
    removedCount: items.length - consolidatedItems.length,
  };
}

function comparableProjection(...values: Array<string | undefined>) {
  return JSON.stringify(values.map((value) =>
    value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") ?? ""));
}

function reviewableKnowledgeEntries(knowledgeBase: ProjectKnowledgeBase) {
  return flattenProjectKnowledgeSemanticEntries(knowledgeBase).map((entry) => ({
    category: entry.category,
    entryKey: canonicalReviewKey(entry.entryKey),
    entryInstanceId: projectKnowledgeEntryInstanceId(entry),
    value: entry.entry,
  }));
}

function canonicalReviewKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function reviewSourceFieldText(fields: Record<string, unknown>, sourceField: string) {
  const value = fields[sourceField];
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return sourceField === "metadata" ? JSON.stringify(value) : String(value);
}

function numberMetric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function knowledgeEntryKeysForSources(
  knowledgeBases: ProjectKnowledgeBase[],
  sourceIds: Set<string>,
) {
  const keys = new Set<string>();
  for (const knowledgeBase of knowledgeBases) {
    for (const entry of flattenProjectKnowledgeSemanticEntries(knowledgeBase)) {
      if (!entry.sourceWorkItemIds.some((sourceId) => sourceIds.has(sourceId))) continue;
      keys.add(`${entry.category}:${entry.entryKey}`);
    }
  }
  return keys;
}

function validateTouchedV2Knowledge(
  knowledgeBase: ProjectKnowledgeBase,
  touchedKeys?: Set<string>,
  suppressedEntryInstanceIds = new Set<string>(),
) {
  const blockers: ProjectKnowledgeDraftBlocker[] = [];
  for (const entry of flattenProjectKnowledgeSemanticEntries(knowledgeBase)) {
    const identity = `${entry.category}:${entry.entryKey}`;
    if (touchedKeys && !touchedKeys.has(identity)) continue;
    const entryInstanceId = projectKnowledgeEntryInstanceId(entry);
    const suppressEvidenceBlocker = suppressedEntryInstanceIds.has(entryInstanceId);
    if (!suppressEvidenceBlocker && !entry.evidenceRefs.length) {
      blockers.push({
        id: projectKnowledgeBlockerId({
          type: "missing_evidence_refs",
          category: entry.category,
          entryKey: entry.entryKey,
          entryInstanceId,
          detailDiscriminator: "missing-evidence",
        }),
        type: "missing_evidence_refs",
        category: entry.category,
        entryKey: entry.entryKey,
        entryInstanceId,
        sourceWorkItemIds: entry.sourceWorkItemIds,
        message: "This entry needs at least one immutable evidence reference before it can be published.",
      });
    }
    if (entry.category === "business_rule") {
      const rule = entry.entry as ProjectKnowledgeBase["businessRules"][number];
      if (PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS.includes(
        rule.sourceField as (typeof PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS)[number],
      )) continue;
      blockers.push({
        id: projectKnowledgeBlockerId({
          type: "invalid_business_rule_source_field",
          category: "business_rule",
          entryKey: entry.entryKey,
          entryInstanceId,
          sourceField: rule.sourceField,
        }),
        type: "invalid_business_rule_source_field",
        category: "business_rule",
        entryKey: entry.entryKey,
        entryInstanceId,
        sourceWorkItemIds: entry.sourceWorkItemIds,
        message: "A v2 business rule sourceField must be title, description, acceptanceCriteria, or metadata.",
      });
    }
  }
  return blockers;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      return asArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function draftNotFound() {
  return new AppError({
    code: AppErrorCode.KnowledgeDraftNotFound,
    message: "Project knowledge draft was not found in the active project.",
    userMessage: "The project knowledge draft was not found.",
  });
}

function staleDraftError() {
  return new AppError({
    code: AppErrorCode.KnowledgeDraftConflict,
    message: "Project knowledge changed after draft generation.",
    userMessage: "The sources or published knowledge changed after this preview. Rebase or regenerate the draft.",
  });
}

function draftStateConflict(status: string) {
  return new AppError({
    code: AppErrorCode.KnowledgeDraftConflict,
    message: `Project knowledge draft cannot transition from ${status}.`,
    userMessage: "This draft is no longer publishable. Refresh its status and regenerate or rebase it.",
  });
}

function publicationBlocked() {
  return new AppError({
    code: AppErrorCode.KnowledgePublicationBlocked,
    message: "Project knowledge draft has unresolved publication blockers.",
    userMessage: "Resolve the draft's evidence or contradiction blockers before publishing.",
  });
}

function contractMismatch() {
  return new AppError({
    code: AppErrorCode.KnowledgeContractMismatch,
    message: "Project knowledge draft uses an incompatible compiler contract.",
    userMessage: "The compiler contract changed after this draft was created. Regenerate the draft.",
  });
}

function isLiveChildUniqueViolation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const databaseError = error as { code?: unknown; constraint?: unknown };
  return databaseError.code === "23505" &&
    (databaseError.constraint === "idx_knowledge_drafts_one_live_child" || !databaseError.constraint);
}

function liveChildConflict() {
  return new AppError({
    code: AppErrorCode.KnowledgeDraftConflict,
    message: "A non-terminal child draft already exists for this parent.",
    userMessage: "This draft has already been rebased. Open its existing child draft.",
  });
}
