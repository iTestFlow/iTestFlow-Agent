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
  type ProjectKnowledgeEntryValue,
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
import {
  resolveProjectKnowledgeDuplicateIdentities,
  type ProjectKnowledgePossibleTension,
} from "./project-knowledge-duplicate-resolution";
import { acquireProjectKnowledgeLock } from "./project-knowledge-lock";
import { backfillProjectKnowledgeCompilerFoundation } from "./project-knowledge-migration.service";
import {
  verifyProjectKnowledgeEvidence,
  type ProjectKnowledgeEvidenceSnapshot,
} from "./project-knowledge-provenance";
import {
  normalizeProjectKnowledgeBlockers,
  projectKnowledgeBlockerId,
  projectKnowledgeEntryInstanceId,
  summarizeProjectKnowledgeReview,
  type ProjectKnowledgeDraftBlocker,
  type ProjectKnowledgeReviewSummary,
} from "./project-knowledge-review.contracts";
import {
  buildProjectKnowledgeOperations,
  type ProjectKnowledgeVersionPrecondition,
} from "./project-knowledge-reconciliation";
import {
  PROJECT_KNOWLEDGE_REQUIRED_OUTPUT_SHAPE,
  ProjectKnowledgeBaseSchema,
  renderProjectKnowledgeEvidenceRefs,
  sortProjectKnowledgeEvidenceRefs,
  type ProjectKnowledgeBase,
} from "./project-knowledge.schema";
import {
  buildProjectKnowledgeDraftPreview,
  type ProjectKnowledgeDraftPreviewCategory,
} from "./project-knowledge-draft-preview";
import {
  hasStrictProjectKnowledgeGrounding,
  omitUnsupportedProjectKnowledgeEntries,
} from "./project-knowledge-grounding";
import { isCompatibleProjectKnowledgeParaphrase } from "./project-knowledge-wording-carryover";

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
  if (input.parentDraftId) {
    throw new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "Project Knowledge v4 does not create rebased child drafts.",
      userMessage: "Rebase is no longer used. Start a new build from the latest publication.",
    });
  }
  return withTransaction(async (client) => {
    await acquireProjectKnowledgeLock(scope, client);
    await backfillProjectKnowledgeCompilerFoundation(scope, client);
    await expireManualProjectKnowledgeDrafts(scope, client);
    const rebaseDepth = 0;

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
    await sqlRun("DELETE FROM project_knowledge_draft_batches WHERE draft_id = @draftId", { draftId: draft.id }, client);
    const now = nowIso();
    const carriedBatches: Array<{
      batchIndex: number;
      rawOutput: string;
      validatedOutput: ProjectKnowledgeBase;
    }> = [];
    for (const batch of input.batches) {
      const promptHash = hashCanonicalValue({ system: batch.systemPrompt, user: batch.userPrompt });
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
          status: "awaiting_input",
          promptHash,
          compilerContractVersion: draft.compiler_contract_version,
          systemPrompt: batch.systemPrompt,
          userPrompt: batch.userPrompt,
          rawOutput: null,
          validatedOutputJson: null,
          heartbeatAt: now,
          createdAt: now,
          updatedAt: now,
        },
        client,
      );
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
    if (!["generating", "awaiting_input", "ready_for_review", "ready_to_publish", "blocked"].includes(row.status)) {
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
    const verification = verifyProjectKnowledgeEvidence({
      knowledgeBase: parsedKnowledge,
      snapshots: evidenceSnapshots,
    });
    const strictGrounding = omitUnsupportedProjectKnowledgeEntries(verification.knowledgeBase);
    if (flattenProjectKnowledgeSemanticEntries(parsedKnowledge).length > 0 &&
        flattenProjectKnowledgeSemanticEntries(strictGrounding.knowledgeBase).length === 0) {
      throw new AppError({
        code: AppErrorCode.SchemaValidation,
        message: "Every proposed project-knowledge entry failed frozen-source evidence validation.",
        userMessage: "The build produced no grounded knowledge. The active publication was not changed.",
      });
    }
    if (!hasStrictProjectKnowledgeGrounding(strictGrounding.knowledgeBase)) {
      throw new AppError({
        code: AppErrorCode.KnowledgePublicationBlocked,
        message: "The v4 draft contains unsupported project-knowledge entries after validation.",
        userMessage: "The draft failed grounding validation. Start a new build.",
      });
    }
    const duplicateResolution = resolveProjectKnowledgeDuplicateIdentities(strictGrounding.knowledgeBase);
    const resolvedKnowledgeBase = duplicateResolution.knowledgeBase;
    const conflicts = detectProjectKnowledgeHardConflicts(resolvedKnowledgeBase);
    const hashes = computeProjectKnowledgeHashes(resolvedKnowledgeBase);
    const operations: ProjectKnowledgeOperation[] = buildProjectKnowledgeOperations({
      baseKnowledgeBase,
      proposedKnowledgeBase: resolvedKnowledgeBase,
      baseVersions,
      touchedKeys,
    });
    operations.push(...hardConflictOperations(conflicts));
    const hardConflictBlockers = buildHardConflictBlockers(conflicts);
    const blockers = normalizeProjectKnowledgeBlockers(hardConflictBlockers);
    const status: ProjectKnowledgeDraftStatus = blockers.length ? "blocked" : "ready_to_publish";
    const statusReason = status === "blocked" ? "hard_conflict" : null;
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
        proposedKnowledgeJson: JSON.stringify(resolvedKnowledgeBase),
        operationsJson: JSON.stringify(operations),
        blockersJson: JSON.stringify(blockers),
        metricsJson: JSON.stringify({
          ...(input.metrics ?? {}),
          automaticDuplicateConsolidationCount:
            numberMetric(input.metrics?.automaticDuplicateConsolidationCount) +
            boundaryConsolidation.automaticDuplicateConsolidationCount,
          preConsolidationDuplicateIdentityCount:
            duplicateResolution.counters.preConsolidationDuplicateIdentityCount,
          paraphraseMergeCount: duplicateResolution.counters.paraphraseMergeCount,
          rekeyCount: duplicateResolution.counters.rekeyCount,
          atomicExtractionFailureCount: duplicateResolution.counters.atomicExtractionFailureCount,
          possibleTensionCount: duplicateResolution.counters.possibleTensionCount,
          possibleTensions: duplicateResolution.possibleTensions,
          quoteExactCount: verification.counts.exact,
          quoteNormalizedCount: verification.counts.normalized,
          quoteAutoReanchorCount: verification.counts.autoReanchored,
          quoteMismatchCount: verification.counts.mismatch,
          omittedEntryCount:
            numberMetric(input.metrics?.omittedEntryCount) + strictGrounding.omittedEntryCount,
          autoEvidenceRepairAttemptedCount: 0,
          autoEvidenceRepairCount: 0,
          autoEvidenceRepairUnresolvedCount: 0,
          manualReanchorCount: 0,
          touchedEntryCount: operations.length,
          conflictCount: conflicts.length,
        }),
        semanticHash: hashes.semanticKnowledgeHash,
        provenanceHash: hashes.provenanceHash,
        heartbeatAt: now,
        reviewReady: status === "ready_to_publish" || status === "blocked",
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
}) {
  const scope = assertProjectScope(input.scope);
  const result = await withTransaction(async (client) => {
    await acquireProjectKnowledgeLock(scope, client);
    const draft = await getDraftRow(scope, input.draftId, client, true);
    if (!draft) return { kind: "not_found" as const };
    if (draft.status === "published") return { kind: "published" as const, draft: toDraft(draft) };
    if (draft.compiler_contract_version !== PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION) {
      return { kind: "contract_mismatch" as const };
    }
    if (draft.status === "blocked" || asArray(draft.blockers_json).length) {
      return { kind: "blocked" as const };
    }
    if (draft.status !== "ready_to_publish") {
      return { kind: "invalid_state" as const, status: draft.status };
    }

    const current = await loadCurrentKnowledge(scope, client, true);
    if ((current?.active_revision_id ?? null) !== draft.base_revision_id) {
      const now = nowIso();
      await sqlRun(
        `
          UPDATE project_knowledge_drafts
          SET status = 'superseded', status_reason = 'active_revision_changed',
              pending_drift = false, updated_at = @now
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
        action: "rag.knowledge_draft.outdated",
        status: "Info",
        actor: input.actor,
        message: "Did not publish an outdated project knowledge draft because another revision is active.",
        details: {
          baseRevisionId: draft.base_revision_id,
          activeRevisionId: current?.active_revision_id ?? null,
        },
      }, client);
      return { kind: "outdated" as const, draft: await requireDraft(scope, draft.id, client) };
    }

    const knowledgeBase = ProjectKnowledgeBaseSchema.parse(draft.proposed_knowledge_json);
    const hashes = computeProjectKnowledgeHashes(knowledgeBase);
    if (hashes.semanticKnowledgeHash !== draft.semantic_hash || hashes.provenanceHash !== draft.provenance_hash) {
      return { kind: "invalid_payload" as const };
    }
    if (!hasStrictProjectKnowledgeGrounding(knowledgeBase)) {
      return { kind: "invalid_grounding" as const };
    }
    const frozenManifest = ProjectKnowledgeSourceManifestSchema.parse(asArray(draft.source_manifest_json));
    const now = nowIso();
    const knowledgeBaseId = current?.id ?? createId("pkb");
    const provenanceStatus = wholeKnowledgeProvenanceStatus(knowledgeBase);
    const freshnessStatus = draft.pending_drift ? "stale" : "current";
    const staleReasons = draft.pending_drift
      ? [{
          type: "source_updates_after_build",
          detectedAt: now,
          message: "Newer source updates will be included in the next build.",
        }]
      : [];
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
          @compilerContractVersion, @wordingVersion, @freshnessStatus,
          @provenanceStatus, 'current', @staleSince, @staleReasonJson
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
          freshness_status = EXCLUDED.freshness_status,
          provenance_status = EXCLUDED.provenance_status,
          compiler_compatibility = 'current',
          stale_since = EXCLUDED.stale_since,
          stale_reason_json = EXCLUDED.stale_reason_json
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
        sourceWorkItemCount: frozenManifest.length,
        rawOutput: draft.raw_output,
        validatedOutput: JSON.stringify(knowledgeBase),
        extractedAt: now,
        createdAt: now,
        updatedAt: now,
        sourceManifestJson: JSON.stringify(frozenManifest),
        sourceFingerprint: draft.source_fingerprint,
        semanticHash: hashes.semanticKnowledgeHash,
        provenanceHash: hashes.provenanceHash,
        semanticHashVersion: PROJECT_KNOWLEDGE_SEMANTIC_HASH_VERSION,
        provenanceHashVersion: PROJECT_KNOWLEDGE_PROVENANCE_HASH_VERSION,
        compilerContractVersion: draft.compiler_contract_version,
        wordingVersion: draft.wording_version,
        freshnessStatus,
        staleSince: draft.pending_drift ? now : null,
        staleReasonJson: JSON.stringify(staleReasons),
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
      sourceWorkItemCount: frozenManifest.length,
      mode: draft.compilation_mode,
      sourceChangeSummary: {
        draftId: draft.id,
        operationCount: asArray(draft.operations_json).length,
        freshnessStatus,
      },
      baseRevisionId: draft.base_revision_id,
      sourceManifest: frozenManifest,
      sourceFingerprint: draft.source_fingerprint,
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
      message: `Published the exact reviewed project knowledge draft as revision ${revision.revisionNumber}.`,
      details: {
        draftId: draft.id,
        revisionNumber: revision.revisionNumber,
        freshnessStatus,
        semanticHash: hashes.semanticKnowledgeHash,
      },
    }, client);
    return { kind: "success" as const, knowledgeBaseId, revision, draftId: draft.id, freshnessStatus };
  });

  if (result.kind === "not_found") throw draftNotFound();
  if (result.kind === "blocked") throw publicationBlocked();
  if (result.kind === "contract_mismatch") throw contractMismatch();
  if (result.kind === "invalid_payload") {
    throw new AppError({
      code: AppErrorCode.KnowledgePublicationBlocked,
      message: "Draft hashes do not match the persisted proposal.",
      userMessage: "The draft failed integrity validation. Regenerate it before publishing.",
    });
  }
  if (result.kind === "invalid_grounding") {
    throw new AppError({
      code: AppErrorCode.KnowledgePublicationBlocked,
      message: "A v4 publication requires verified immutable evidence for every entry.",
      userMessage: "The draft failed grounding validation. Start a new build.",
    });
  }
  if (result.kind === "invalid_state") throw draftStateConflict(result.status);
  if (result.kind === "published") return result.draft;
  if (result.kind === "outdated") return result.draft;

  try {
    await runProjectKnowledgeLint({ scope });
  } catch (error) {
    console.error("Project knowledge lint failed after draft publication", error);
  }
  return getProjectKnowledgeDraft({ scope, draftId: result.draftId });
}



export type ProjectKnowledgeConflictDecision =
  | {
      conflictId: string;
      action: "keep";
      participantId: string;
    }
  | {
      conflictId: string;
      action: "combine";
      fieldParticipants: Record<string, string>;
    };

export async function getProjectKnowledgeDraftConflicts(input: {
  scope: ProjectScope;
  draftId: string;
  page?: number;
  pageSize?: number;
}) {
  const draft = await getProjectKnowledgeDraft({ scope: input.scope, draftId: input.draftId });
  if (!draft) throw draftNotFound();
  const conflicts = draft.blockers.filter((blocker) => blocker.type === "hard_conflict");
  const pageSize = Math.min(50, Math.max(1, input.pageSize ?? 50));
  const page = Math.max(1, input.page ?? 1);
  const start = (page - 1) * pageSize;
  return {
    draftVersion: projectKnowledgeDraftVersion(draft),
    counts: {
      total: conflicts.length,
      resolved: 0,
      remaining: conflicts.length,
    },
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(conflicts.length / pageSize)),
    conflicts: conflicts.slice(start, start + pageSize).map((conflict) => ({
      conflictId: conflict.id,
      identityKey: conflict.identityKey,
      subject: conflict.subject,
      affectedCategory: conflict.affectedCategory,
      conflictType: conflict.conflictType,
      ...(conflict.conflictBasis ? { conflictBasis: conflict.conflictBasis } : {}),
      participants: conflict.participants.map((participant) => ({
        participantId: participant.participantId,
        entryKey: participant.entryKey,
        fields: participant.projection,
        evidence: participant.evidenceRefs.map((ref) => ({
          sourceField: ref.sourceField,
          quote: ref.quote,
          sourceWorkItemId: ref.sourceWorkItemId,
        })),
      })),
    })),
    possibleTensions: possibleTensionsFromMetrics(draft.metrics.possibleTensions),
  };
}

export async function getProjectKnowledgeDraftPreview(input: {
  scope: ProjectScope;
  draftId: string;
  category?: ProjectKnowledgeDraftPreviewCategory;
  query?: string;
  page?: number;
  pageSize?: number;
}) {
  const draft = await getProjectKnowledgeDraft({ scope: input.scope, draftId: input.draftId });
  if (!draft) throw draftNotFound();
  if (draft.persistedStatus !== "ready_to_publish" || !draft.proposedKnowledge) {
    throw draftStateConflict(draft.persistedStatus);
  }
  return buildProjectKnowledgeDraftPreview({
    draftId: draft.id,
    draftVersion: projectKnowledgeDraftVersion(draft),
    status: draft.persistedStatus,
    knowledgeBase: draft.proposedKnowledge,
    category: input.category,
    query: input.query,
    page: input.page,
    pageSize: input.pageSize,
  });
}

export async function applyProjectKnowledgeConflictDecisions(input: {
  scope: ProjectScope;
  actor: string;
  draftId: string;
  draftVersion: string;
  decisions: ProjectKnowledgeConflictDecision[];
}) {
  const draft = await getProjectKnowledgeDraft({ scope: input.scope, draftId: input.draftId });
  if (!draft) throw draftNotFound();
  if (draft.compilerContractVersion !== PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION) {
    throw contractMismatch();
  }
  if (draft.persistedStatus !== "blocked" || !draft.proposedKnowledge) {
    throw draftStateConflict(draft.persistedStatus);
  }
  if (projectKnowledgeDraftVersion(draft) !== input.draftVersion) {
    throw new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "The compact conflict decisions target an outdated draft version.",
      userMessage: "This conflict list changed. Reload it before applying decisions.",
    });
  }

  const blockers = draft.blockers.filter((blocker) => blocker.type === "hard_conflict");
  const blockersById = new Map(blockers.map((blocker) => [blocker.id, blocker]));
  const decisionsById = new Map(input.decisions.map((decision) => [decision.conflictId, decision]));
  if (decisionsById.size !== blockers.length || blockers.some((blocker) => !decisionsById.has(blocker.id))) {
    throw new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "Every current semantic conflict requires exactly one compact decision.",
      userMessage: "Choose an option for every conflict before applying decisions.",
    });
  }

  let resolvedKnowledge = structuredClone(draft.proposedKnowledge);
  for (const decision of input.decisions) {
    const blocker = blockersById.get(decision.conflictId);
    if (!blocker) throw draftStateConflict("unknown_conflict");
    const participantById = new Map(blocker.participants.map((participant) => [participant.participantId, participant]));
    const resolvedEntry = decision.action === "keep"
      ? participantById.get(decision.participantId)?.entry
      : combineProjectKnowledgeConflictParticipants(blocker, decision.fieldParticipants);
    if (!resolvedEntry) {
      throw new AppError({
        code: AppErrorCode.KnowledgeDraftConflict,
        message: "A conflict decision referenced an unknown participant.",
        userMessage: "One selected conflict version is no longer available. Reload the conflicts.",
      });
    }
    resolvedKnowledge = replaceProjectKnowledgeConflictParticipants({
      knowledgeBase: resolvedKnowledge,
      category: blocker.affectedCategory,
      participants: blocker.participants,
      resolvedEntry,
    });
  }

  return completeProjectKnowledgeDraft({
    scope: input.scope,
    draftId: draft.id,
    provider: draft.provider ?? "reviewer",
    model: draft.model ?? "compact-conflict-decisions",
    rawOutput: draft.rawOutput ?? "",
    knowledgeBase: resolvedKnowledge,
    recoverMissingEvidenceRefs: false,
    metrics: {
      ...draft.metrics,
      compactDecisionCount: input.decisions.length,
      decisionApplyCount: Number(draft.metrics.decisionApplyCount ?? 0) + 1,
    },
  });
}

function projectKnowledgeDraftVersion(draft: ProjectKnowledgeDraft) {
  return `pkdv_${hashCanonicalValue({
    draftId: draft.id,
    semanticHash: draft.semanticHash,
    provenanceHash: draft.provenanceHash,
    conflicts: draft.blockers.filter((blocker) => blocker.type === "hard_conflict")
      .map((blocker) => blocker.identityKey),
  }).slice(0, 32)}`;
}

function combineProjectKnowledgeConflictParticipants(
  blocker: Extract<ProjectKnowledgeDraftBlocker, { type: "hard_conflict" }>,
  fieldParticipants: Record<string, string>,
) {
  const allowedFields = projectKnowledgeConflictFields(blocker.affectedCategory);
  if (Object.keys(fieldParticipants).some((field) => !allowedFields.includes(field))) return null;
  if (!allowedFields.every((field) => typeof fieldParticipants[field] === "string")) return null;
  const byId = new Map(blocker.participants.map((participant) => [participant.participantId, participant]));
  const base = structuredClone(blocker.participants[0]?.entry) as Record<string, unknown> | undefined;
  if (!base) return null;
  const selectedParticipants = new Set<string>();
  for (const field of allowedFields) {
    const participantId = fieldParticipants[field];
    const participant = byId.get(participantId);
    if (!participant) return null;
    base[field] = (participant.entry as unknown as Record<string, unknown>)[field];
    selectedParticipants.add(participantId);
  }
  const evidenceRefs = sortProjectKnowledgeEvidenceRefs(Array.from(new Map(
    Array.from(selectedParticipants).flatMap((participantId) => byId.get(participantId)?.evidenceRefs ?? [])
      .map((ref) => [[ref.sourceSnapshotId, ref.sourceField, ref.quote].join("\u0000"), ref]),
  ).values()));
  base.evidenceRefs = evidenceRefs;
  base.sourceWorkItemIds = Array.from(new Set(evidenceRefs.map((ref) => ref.sourceWorkItemId)));
  base.evidence = renderProjectKnowledgeEvidenceRefs(evidenceRefs);
  return base as unknown as ProjectKnowledgeEntryValue;
}

function projectKnowledgeConflictFields(category: ProjectKnowledgeEntryCategory) {
  const fields: Record<ProjectKnowledgeEntryCategory, string[]> = {
    module: ["name", "description"],
    business_rule: ["rule", "sourceField", "moduleName"],
    state_transition: ["workflowName", "fromState", "toState", "triggerOrCondition", "actor", "moduleName"],
    glossary: ["term", "type", "definition"],
    dependency: ["sourceModule", "targetModule", "dependencyType", "description"],
  };
  return fields[category];
}

function replaceProjectKnowledgeConflictParticipants(input: {
  knowledgeBase: ProjectKnowledgeBase;
  category: ProjectKnowledgeEntryCategory;
  participants: ProjectKnowledgeHardConflict["participants"];
  resolvedEntry: ProjectKnowledgeEntryValue;
}) {
  const participantHashes = new Set(input.participants.map((participant) => hashCanonicalValue(participant.entry)));
  const replace = <T>(entries: T[]) => [
    ...entries.filter((entry) => !participantHashes.has(hashCanonicalValue(entry))),
    input.resolvedEntry as unknown as T,
  ];
  return ProjectKnowledgeBaseSchema.parse({
    modules: input.category === "module" ? replace(input.knowledgeBase.modules) : input.knowledgeBase.modules,
    businessRules: input.category === "business_rule" ? replace(input.knowledgeBase.businessRules) : input.knowledgeBase.businessRules,
    stateTransitions: input.category === "state_transition" ? replace(input.knowledgeBase.stateTransitions) : input.knowledgeBase.stateTransitions,
    glossary: input.category === "glossary" ? replace(input.knowledgeBase.glossary) : input.knowledgeBase.glossary,
    crossDependencies: input.category === "dependency" ? replace(input.knowledgeBase.crossDependencies) : input.knowledgeBase.crossDependencies,
  });
}

export async function getProjectKnowledgeDraft(input: { scope: ProjectScope; draftId: string }) {
  const scope = assertProjectScope(input.scope);
  await expireManualProjectKnowledgeDrafts(scope);
  await supersedeOutdatedContractDrafts(scope);
  const row = await getDraftRow(scope, input.draftId);
  return row ? toDraft(row) : null;
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
  await supersedeOutdatedContractDrafts(scope);
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
      SET pending_drift = true, updated_at = @now
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND status IN ('generating', 'awaiting_input', 'ready_for_review', 'ready_to_publish', 'blocked')
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

async function loadCurrentKnowledge(scope: ProjectScope, client?: PoolClient, forUpdate = false) {
  return sqlGet<CurrentKnowledgeRow>(
    `
      SELECT id, active_revision_id, validated_output, semantic_hash, provenance_hash
      FROM project_knowledge_base
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
      LIMIT 1
      ${forUpdate ? "FOR UPDATE" : ""}
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
      ...(conflict.conflictBasis ? { conflictBasis: conflict.conflictBasis } : {}),
      message: conflict.evidenceIdentical
        ? "These entries cite identical source evidence and differ only in wording. Keep the version that should be published."
        : "These source-backed entries disagree and require a reviewer decision.",
    };
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
// every draft completion, including the compact-decision boundary where entries
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
  const consolidatedItems = Array.from(groups.values()).flatMap((entries) =>
    partitionSafeDuplicateEntries(category, entries).map((compatibleEntries) =>
      mergeProjectKnowledgeConflictEntries(category, compatibleEntries)));
  return {
    items: consolidatedItems,
    removedCount: items.length - consolidatedItems.length,
  };
}

function comparableProjection(...values: Array<string | undefined>) {
  return JSON.stringify(values.map((value) =>
    value?.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") ?? ""));
}

function numberMetric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Boundary consolidation must never erase hash-neutral constraint metadata or
 * distinct dependency evidence merely because the old semantic projection is
 * identical. Requiring every pair to pass the category gate preserves those
 * survivors for the duplicate-resolution/re-key pass immediately downstream.
 */
function partitionSafeDuplicateEntries<TCategory extends ProjectKnowledgeConsolidationCategory>(
  category: TCategory,
  entries: ProjectKnowledgeEntryByConsolidationCategory[TCategory][],
) {
  const groups: ProjectKnowledgeEntryByConsolidationCategory[TCategory][][] = [];
  for (const entry of entries) {
    const compatibleGroup = groups.find((group) =>
      group.every((candidate) => isCompatibleProjectKnowledgeParaphrase(category, candidate, entry)));
    if (compatibleGroup) compatibleGroup.push(entry);
    else groups.push([entry]);
  }
  return groups;
}

function possibleTensionsFromMetrics(value: unknown): ProjectKnowledgePossibleTension[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const tension = item as Record<string, unknown>;
    const category = typeof tension.category === "string" ? tension.category : "";
    const subject = typeof tension.subject === "string" ? tension.subject : "";
    const reason = typeof tension.reason === "string" ? tension.reason : "";
    const entryKeys = Array.isArray(tension.entryKeys)
      ? tension.entryKeys.filter((entryKey): entryKey is string => typeof entryKey === "string")
      : [];
    if (
      !["module", "business_rule", "state_transition", "glossary", "dependency"].includes(category) ||
      !subject ||
      !reason ||
      !entryKeys.length
    ) {
      return [];
    }
    return [{ category: category as ProjectKnowledgePossibleTension["category"], subject, entryKeys, reason }];
  });
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

function draftStateConflict(status: string) {
  return new AppError({
    code: AppErrorCode.KnowledgeDraftConflict,
    message: `Project knowledge draft cannot transition from ${status}.`,
    userMessage: "This draft is no longer publishable. Refresh its status and start a new build.",
  });
}

function publicationBlocked() {
  return new AppError({
    code: AppErrorCode.KnowledgePublicationBlocked,
    message: "Project knowledge draft has unresolved semantic conflicts.",
    userMessage: "Resolve every knowledge conflict before publishing.",
  });
}

function contractMismatch() {
  return new AppError({
    code: AppErrorCode.KnowledgeContractMismatch,
    message: "Project knowledge draft uses an incompatible compiler contract.",
    userMessage: "The compiler contract changed after this draft was created. Regenerate the draft.",
  });
}

/**
 * A compiler-contract change invalidates every live draft without mutating its
 * frozen proposal. The update runs lazily on reads, so old blocked drafts are
 * never recompiled or re-detected just to display their current status.
 */
async function supersedeOutdatedContractDrafts(scope: ProjectScope, client?: PoolClient) {
  const now = nowIso();
  await sqlRun(
    `
      UPDATE project_knowledge_drafts
      SET status = 'superseded', status_reason = 'compiler_contract_upgraded', updated_at = @now
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND compiler_contract_version <> @compilerContractVersion
        AND status IN ('generating', 'awaiting_input', 'ready_for_review', 'ready_to_publish', 'blocked', 'rebase_required')
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      compilerContractVersion: PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
      now,
    },
    client,
  );
}
