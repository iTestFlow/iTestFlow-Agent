import "server-only";

import type { PoolClient } from "pg";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { AppError, AppErrorCode } from "@/modules/shared/errors/app-error";
import { createId, enqueueBackgroundWrite, nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS,
  renderProjectKnowledgeEvidenceRefs,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeEvidenceRef,
} from "./project-knowledge.schema";
import {
  PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
  PROJECT_KNOWLEDGE_PROVENANCE_HASH_VERSION,
  PROJECT_KNOWLEDGE_SEMANTIC_HASH_VERSION,
  PROJECT_KNOWLEDGE_WORDING_VERSION,
  canonicalizeBusinessRuleSourceFieldForProjection,
  computeProjectKnowledgeHashes,
  type ProjectKnowledgeSourceManifestEntry,
} from "./project-knowledge-contracts";
import { listProjectKnowledgeBenchmarkCases } from "./project-knowledge-benchmark.service";
import { matchLegacyEvidenceFragmentUniquely } from "./project-knowledge-migration.service";

type FsModule = typeof import("fs");
type PathModule = typeof import("path");
type CryptoModule = typeof import("crypto");

export type ProjectKnowledgeCompilationMode = "incremental" | "full" | "manual" | "promoted";
export type ProjectKnowledgeLogSeverity = "info" | "warning" | "error";
export const PROJECT_KNOWLEDGE_CANDIDATE_STATUSES = [
  "legacy_ungrounded",
  "grounded",
  "rejected",
  "integration_requested",
] as const;
export type ProjectKnowledgeCandidateStatus = (typeof PROJECT_KNOWLEDGE_CANDIDATE_STATUSES)[number];

export type ProjectKnowledgeLogItem = {
  id: string;
  eventType: string;
  severity: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  sourceIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type ProjectKnowledgeLintIssue = {
  id: string;
  issueType: string;
  severity: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  category?: string | null;
  entryKey?: string | null;
  sourceWorkItemIds: string[];
  status: string;
  origin: "deterministic" | "human";
  createdAt: string;
  updatedAt: string;
};

type KnowledgeEntry = {
  category: string;
  entryKey: string;
  title: string;
  content: string;
  sourceWorkItemIds: string[];
  evidence: string;
  evidenceRefs: ProjectKnowledgeEvidenceRef[];
  metadata: Record<string, unknown>;
};

type SourceWorkItemRow = {
  azure_work_item_id: string;
  title: string;
  sync_status: string | null;
};

type KnowledgeSnapshotRow = {
  id: string;
  provider: string | null;
  model_name: string | null;
  source_work_item_count: number;
  raw_output: string | null;
  validated_output: string;
};

type KnowledgeLogRow = {
  id: string;
  event_type: string;
  severity: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  source_ids: string;
  metadata_json: string | null;
  created_at: string;
};

type KnowledgeLintRow = {
  id: string;
  issue_type: string;
  severity: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  category: string | null;
  entry_key: string | null;
  source_work_item_ids: string;
  status: string;
  origin: "deterministic" | "human";
  created_at: string;
  updated_at: string;
};

type KnowledgeCandidateRow = {
  id: string;
  title: string;
  content: string;
  status: string;
  source_work_item_ids: unknown;
  evidence_refs_json: unknown;
  citations_json: unknown;
  rejected_reason: string | null;
  created_at: string;
  updated_at: string;
};

export async function recordProjectKnowledgeRevision(input: {
  scope: ProjectScope;
  knowledgeBaseId: string;
  knowledgeBase: ProjectKnowledgeBase;
  provider?: string | null;
  model?: string | null;
  rawOutput?: string | null;
  sourceWorkItemCount: number;
  mode: ProjectKnowledgeCompilationMode;
  sourceChangeSummary?: Record<string, unknown>;
  baseRevisionId?: string | null;
  sourceManifest?: ProjectKnowledgeSourceManifestEntry[];
  sourceFingerprint?: string | null;
  compilerContractVersion?: string;
  wordingVersion?: string;
  metrics?: Record<string, unknown>;
}, client?: PoolClient) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  const revisionId = createId("pkr");
  const revisionNumber = await nextRevisionNumber(scope, client);
  const validatedOutput = JSON.stringify(input.knowledgeBase);
  const entries = flattenProjectKnowledge(input.knowledgeBase);
  const hashSet = computeProjectKnowledgeHashes(input.knowledgeBase);
  const entryKeys = hashSet.entries.map((entry) => knowledgeVersionKey(entry.category, entry.entryKey));
  if (new Set(entryKeys).size !== entryKeys.length) {
    throw new AppError({
      code: AppErrorCode.KnowledgePublicationBlocked,
      message: "Project knowledge contains duplicate canonical entry identities.",
      userMessage: "Resolve duplicate knowledge identities before publishing.",
    });
  }
  const hashesByKey = new Map(
    hashSet.entries.map((entry) => [knowledgeVersionKey(entry.category, entry.entryKey), entry]),
  );

  const previousActive = await sqlAll<{
    id: string;
    category: string;
    entry_key: string;
    content_hash: string;
    entry_semantic_hash: string | null;
    entry_provenance_hash: string | null;
  }>(
    `
      SELECT id, category, entry_key, content_hash,
             entry_semantic_hash, entry_provenance_hash
      FROM project_knowledge_entry_versions
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND status = 'active'
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
    client,
  );
  const previousByKey = new Map(previousActive.map((entry) => [knowledgeVersionKey(entry.category, entry.entry_key), entry]));
  const nextKeys = new Set(entries.map((entry) => knowledgeVersionKey(entry.category, entry.entryKey)));

  await sqlRun(
    `
    INSERT INTO project_knowledge_revisions (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      knowledge_base_id, revision_number, mode, provider, model_name,
      source_work_item_count, source_change_summary_json, raw_output, validated_output, created_at,
      base_revision_id, source_manifest_json, source_fingerprint, semantic_hash,
      provenance_hash, semantic_hash_version, provenance_hash_version,
      compiler_contract_version, wording_version, metrics_json
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @knowledgeBaseId, @revisionNumber, @mode, @provider, @model,
      @sourceWorkItemCount, @sourceChangeSummaryJson, @rawOutput, @validatedOutput, @createdAt,
      @baseRevisionId, @sourceManifestJson, @sourceFingerprint, @semanticHash,
      @provenanceHash, @semanticHashVersion, @provenanceHashVersion,
      @compilerContractVersion, @wordingVersion, @metricsJson
    )
  `,
    {
      id: revisionId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      knowledgeBaseId: input.knowledgeBaseId,
      revisionNumber,
      mode: input.mode,
      provider: input.provider ?? null,
      model: input.model ?? null,
      sourceWorkItemCount: input.sourceWorkItemCount,
      sourceChangeSummaryJson: JSON.stringify(input.sourceChangeSummary ?? {}),
      rawOutput: input.rawOutput ?? null,
      validatedOutput,
      createdAt: now,
      baseRevisionId: input.baseRevisionId ?? null,
      sourceManifestJson: JSON.stringify(input.sourceManifest ?? []),
      sourceFingerprint: input.sourceFingerprint ?? null,
      semanticHash: hashSet.semanticKnowledgeHash,
      provenanceHash: hashSet.provenanceHash,
      semanticHashVersion: PROJECT_KNOWLEDGE_SEMANTIC_HASH_VERSION,
      provenanceHashVersion: PROJECT_KNOWLEDGE_PROVENANCE_HASH_VERSION,
      compilerContractVersion: input.compilerContractVersion ?? PROJECT_KNOWLEDGE_COMPILER_CONTRACT_VERSION,
      wordingVersion: input.wordingVersion ?? PROJECT_KNOWLEDGE_WORDING_VERSION,
      metricsJson: JSON.stringify(input.metrics ?? {}),
    },
    client,
  );

  const INSERT_VERSION_SQL = `
    INSERT INTO project_knowledge_entry_versions (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      knowledge_base_id, revision_id, category, entry_key, title, content, status,
      source_work_item_ids, evidence, metadata_json, content_hash,
      superseded_by_entry_version_id, created_at, updated_at,
      entry_semantic_hash, entry_provenance_hash, semantic_hash_version, provenance_hash_version
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @knowledgeBaseId, @revisionId, @category, @entryKey, @title, @content, 'active',
      @sourceWorkItemIds, @evidence, @metadataJson, @contentHash,
      NULL, @createdAt, @updatedAt,
      @entrySemanticHash, @entryProvenanceHash, @semanticHashVersion, @provenanceHashVersion
    )
  `;
  const SUPERSEDE_PREVIOUS_SQL = `
    UPDATE project_knowledge_entry_versions
    SET status = @status,
        superseded_by_entry_version_id = @supersededBy,
        updated_at = @updatedAt
    WHERE id = @id
  `;

  let createdCount = 0;
  let updatedCount = 0;
  let confirmedCount = 0;

  for (const entry of entries) {
    const versionKey = knowledgeVersionKey(entry.category, entry.entryKey);
    const previous = previousByKey.get(versionKey);
    const hashes = hashesByKey.get(versionKey);
    if (!hashes) throw new Error(`Missing hashes for knowledge entry ${versionKey}.`);

    if (
      previous?.entry_semantic_hash === hashes.entrySemanticHash &&
      previous.entry_provenance_hash === hashes.entryProvenanceHash
    ) {
      confirmedCount += 1;
      continue;
    }

    const id = createId("pkev");
    const contentHash = stableHash(
      [entry.category, entry.entryKey, entry.title, entry.content, entry.evidence, entry.sourceWorkItemIds].join("\n"),
    );

    await sqlRun(INSERT_VERSION_SQL, {
      id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      knowledgeBaseId: input.knowledgeBaseId,
      revisionId,
      category: entry.category,
      entryKey: entry.entryKey,
      title: entry.title,
      content: entry.content,
      sourceWorkItemIds: JSON.stringify(entry.sourceWorkItemIds),
      evidence: entry.evidence,
      metadataJson: JSON.stringify(entry.metadata),
      contentHash,
      entrySemanticHash: hashes.entrySemanticHash,
      entryProvenanceHash: hashes.entryProvenanceHash,
      semanticHashVersion: PROJECT_KNOWLEDGE_SEMANTIC_HASH_VERSION,
      provenanceHashVersion: PROJECT_KNOWLEDGE_PROVENANCE_HASH_VERSION,
      createdAt: now,
      updatedAt: now,
    }, client);

    for (const [sortOrder, ref] of entry.evidenceRefs.entries()) {
      await sqlRun(
        `
          INSERT INTO project_knowledge_entry_evidence_refs (
            id, workspace_id, project_id, azure_project_id, entry_version_id,
            source_snapshot_id, source_work_item_id, source_field, quote,
            locator_json, origin, verification, sort_order, created_at
          ) VALUES (
            @id, (SELECT workspace_id FROM projects WHERE id = @projectId), @projectId, @azureProjectId, @entryVersionId,
            @sourceSnapshotId, @sourceWorkItemId, @sourceField, @quote,
            @locatorJson, @origin, @verification, @sortOrder, @createdAt
          )
        `,
        {
          id: createId("pkeref"),
          projectId: scope.projectId,
          azureProjectId: scope.azureProjectId,
          entryVersionId: id,
          sourceSnapshotId: ref.sourceSnapshotId,
          sourceWorkItemId: ref.sourceWorkItemId,
          sourceField: ref.sourceField,
          quote: ref.quote,
          locatorJson: ref.locator ? JSON.stringify(ref.locator) : null,
          origin: ref.origin,
          verification: ref.verification,
          sortOrder,
          createdAt: now,
        },
        client,
      );
    }

    if (!previous) {
      createdCount += 1;
      continue;
    }

    updatedCount += 1;

    await sqlRun(SUPERSEDE_PREVIOUS_SQL, {
      id: previous.id,
      status: "superseded",
      supersededBy: id,
      updatedAt: now,
    }, client);
  }

  let retiredCount = 0;
  for (const entry of previousActive) {
    if (nextKeys.has(knowledgeVersionKey(entry.category, entry.entry_key))) continue;
    retiredCount += 1;
    await sqlRun(SUPERSEDE_PREVIOUS_SQL, {
      id: entry.id,
      status: "retired",
      supersededBy: null,
      updatedAt: now,
    }, client);
  }

  await recordProjectKnowledgeLog({
    scope,
    eventType: "knowledge.revision_saved",
    severity: "info",
    title: `Saved knowledge revision ${revisionNumber}`,
    message: `Compiled ${entries.length} active knowledge entries from ${input.sourceWorkItemCount} source work items.`,
    metadata: {
      revisionId,
      revisionNumber,
      mode: input.mode,
      createdCount,
      updatedCount,
      confirmedCount,
      retiredCount,
      revisionKind:
        createdCount + updatedCount + retiredCount === 0 && input.sourceFingerprint
          ? "fingerprint_advance"
          : "knowledge_change",
      semanticHash: hashSet.semanticKnowledgeHash,
      provenanceHash: hashSet.provenanceHash,
    },
  }, client);

  return {
    revisionId,
    revisionNumber,
    entryCount: entries.length,
    createdCount,
    updatedCount,
    confirmedCount,
    retiredCount,
    semanticHash: hashSet.semanticKnowledgeHash,
    provenanceHash: hashSet.provenanceHash,
  };
}

export function recordProjectKnowledgeLog(input: {
  scope: ProjectScope;
  eventType: string;
  severity?: ProjectKnowledgeLogSeverity;
  title: string;
  message: string;
  sourceIds?: string[];
  metadata?: Record<string, unknown>;
}, client?: PoolClient) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  const params = {
    id: createId("pkl"),
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    eventType: input.eventType,
    severity: input.severity ?? "info",
    title: input.title,
    message: input.message,
    sourceIds: JSON.stringify(input.sourceIds ?? []),
    metadataJson: JSON.stringify(input.metadata ?? {}),
    createdAt: now,
  };

  const query = `
      INSERT INTO project_knowledge_log (
        id, project_id, azure_project_id, azure_project_name, azure_organization_url,
        event_type, severity, title, message, source_ids, metadata_json, created_at
      ) VALUES (
        @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
        @eventType, @severity, @title, @message, @sourceIds, @metadataJson, @createdAt
      )
    `;
  const write = () => client ? sqlRun(query, params, client) : sqlRun(query, params);

  if (client) return write();
  enqueueBackgroundWrite(`knowledge-log:${input.eventType}`, write);
  return Promise.resolve();
}

export async function getProjectKnowledgeLog(input: { scope: ProjectScope; limit?: number }): Promise<ProjectKnowledgeLogItem[]> {
  const scope = assertProjectScope(input.scope);
  const rows = await sqlAll<KnowledgeLogRow>(
    `
      SELECT id, event_type, severity, title, message, source_ids, metadata_json, created_at
      FROM project_knowledge_log
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY created_at DESC
      LIMIT @limit
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      limit: Math.min(500, Math.max(1, input.limit ?? 30)),
    },
  );

  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    sourceIds: parseJsonArray(row.source_ids),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: row.created_at,
  }));
}

export async function runProjectKnowledgeLint(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  const lintRunId = createId("pklr");
  const snapshot = await getActiveKnowledgeSnapshot(scope);
  const issues: Array<Omit<ProjectKnowledgeLintIssue, "id" | "createdAt" | "updatedAt" | "status" | "origin">> = [];

  if (!snapshot) {
    issues.push({
      issueType: "missing_knowledge_base",
      severity: "warning",
      title: "No compiled knowledge base",
      message: "Index project context and extract the knowledge base before relying on RAG-assisted workflows.",
      sourceWorkItemIds: [],
    });
  } else {
    const knowledgeBase = JSON.parse(snapshot.validated_output) as ProjectKnowledgeBase;
    const entries = flattenProjectKnowledge(knowledgeBase);
    const sourceRows = await loadSourceWorkItems(scope);
    const sourceById = new Map(sourceRows.map((source) => [source.azure_work_item_id, source]));
    const activeSourceIds = new Set(sourceRows.filter((source) => source.sync_status !== "inactive").map((source) => source.azure_work_item_id));
    const moduleNameIndex = buildModuleNameIndex(knowledgeBase.modules);
    const dependencyEndpoints = buildKnownDependencyEndpoints(knowledgeBase);

    addDuplicateEntryKeyIssues(entries, issues);
    addNameSimilarityIssues(knowledgeBase, issues);

    entries.forEach((entry) => {
      const missingSourceIds = entry.sourceWorkItemIds.filter((id) => !sourceById.has(id));
      const inactiveSourceIds = entry.sourceWorkItemIds.filter((id) => sourceById.get(id)?.sync_status === "inactive");

      if (missingSourceIds.length) {
        issues.push({
          issueType: "missing_source",
          severity: "error",
          title: `Missing source for ${entry.title}`,
          message: `The entry cites source work item IDs that are not present in local indexed context: ${missingSourceIds.join(", ")}.`,
          category: entry.category,
          entryKey: entry.entryKey,
          sourceWorkItemIds: missingSourceIds,
        });
      }

      if (inactiveSourceIds.length) {
        issues.push({
          issueType: "stale_source",
          severity: "warning",
          title: `Stale source for ${entry.title}`,
          message: `The entry cites work items no longer returned by the latest context sync: ${inactiveSourceIds.join(", ")}.`,
          category: entry.category,
          entryKey: entry.entryKey,
          sourceWorkItemIds: inactiveSourceIds,
        });
      }

      if (!entry.evidence.trim()) {
        issues.push({
          issueType: "missing_evidence",
          severity: "error",
          title: `Missing evidence for ${entry.title}`,
          message: "Every compiled knowledge entry must include source-backed evidence.",
          category: entry.category,
          entryKey: entry.entryKey,
          sourceWorkItemIds: entry.sourceWorkItemIds,
        });
      }

      if (!entry.sourceWorkItemIds.some((id) => activeSourceIds.has(id))) {
        issues.push({
          issueType: "no_active_source",
          severity: "warning",
          title: `No active source for ${entry.title}`,
          message: "This entry has no active source work item after the latest sync.",
          category: entry.category,
          entryKey: entry.entryKey,
          sourceWorkItemIds: entry.sourceWorkItemIds,
        });
      }
    });

    knowledgeBase.businessRules.forEach((rule) => {
      const projectedSourceField = canonicalizeBusinessRuleSourceFieldForProjection(rule.sourceField);
      if (!PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS.includes(
        projectedSourceField as (typeof PROJECT_KNOWLEDGE_BUSINESS_RULE_SOURCE_FIELDS)[number],
      )) {
        issues.push({
          issueType: "unknown_source_field",
          severity: "warning",
          title: `Unknown source field for ${rule.id}`,
          message: `Business rule uses unrecognized sourceField "${rule.sourceField}". Stored legacy knowledge is not rewritten by lint.`,
          category: "business_rule",
          entryKey: rule.id,
          sourceWorkItemIds: rule.sourceWorkItemIds,
        });
      }
      if (rule.moduleName && !isKnownModuleName(rule.moduleName, moduleNameIndex)) {
        issues.push({
          issueType: "unknown_module_reference",
          severity: "warning",
          title: `Unknown module reference for ${rule.id}`,
          message: `Business rule references module "${rule.moduleName}", but no compiled module with that name exists.`,
          category: "business_rule",
          entryKey: rule.id,
          sourceWorkItemIds: rule.sourceWorkItemIds,
        });
      }
    });

    knowledgeBase.crossDependencies.forEach((dependency) => {
      const missingEndpoints = [
        isKnownDependencyEndpoint(dependency.sourceModule, dependencyEndpoints, dependency, dependency.targetModule) ? "" : dependency.sourceModule,
        isKnownDependencyEndpoint(dependency.targetModule, dependencyEndpoints, dependency, dependency.sourceModule) ||
        isExternalOrReferenceDependencyEndpoint(dependency.targetModule, dependency.dependencyType)
          ? ""
          : dependency.targetModule,
      ].filter(Boolean);
      if (!missingEndpoints.length) return;
      issues.push({
        issueType: "unknown_dependency_endpoint",
        severity: "warning",
        title: `Unknown dependency endpoint for ${dependency.id}`,
        message: `Dependency references endpoints not present as compiled modules, glossary terms, workflow names, or recognized external/reference-data targets: ${missingEndpoints.join(", ")}.`,
        category: "dependency",
        entryKey: dependency.id,
        sourceWorkItemIds: dependency.sourceWorkItemIds,
      });
    });
  }

  const INSERT_ISSUE_SQL = `
    INSERT INTO project_knowledge_lint_issues (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      issue_type, severity, title, message, category, entry_key,
      source_work_item_ids, status, created_at, updated_at,
      issue_fingerprint, origin, first_seen_at, last_seen_at, lint_run_id
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @issueType, @severity, @title, @message, @category, @entryKey,
      @sourceWorkItemIds, 'open', @createdAt, @updatedAt,
      @issueFingerprint, 'deterministic', @createdAt, @updatedAt, @lintRunId
    )
    ON CONFLICT (project_id, azure_project_id, issue_fingerprint)
      WHERE issue_fingerprint IS NOT NULL
    DO UPDATE SET
      severity = EXCLUDED.severity,
      title = EXCLUDED.title,
      message = EXCLUDED.message,
      category = EXCLUDED.category,
      entry_key = EXCLUDED.entry_key,
      source_work_item_ids = EXCLUDED.source_work_item_ids,
      status = CASE
        WHEN project_knowledge_lint_issues.status = 'ignored' THEN 'ignored'
        ELSE 'open'
      END,
      last_seen_at = EXCLUDED.last_seen_at,
      lint_run_id = EXCLUDED.lint_run_id,
      resolved_at = NULL,
      updated_at = EXCLUDED.updated_at
  `;

  const currentFingerprints: string[] = [];
  for (const issue of issues) {
    const issueFingerprint = stableHash(JSON.stringify({
      issueType: issue.issueType,
      category: issue.category ?? null,
      entryKey: issue.entryKey ? normalizeKey(issue.entryKey) : null,
      sourceWorkItemIds: [...issue.sourceWorkItemIds].sort(),
      message: issue.message,
    }));
    currentFingerprints.push(issueFingerprint);
    await sqlRun(INSERT_ISSUE_SQL, {
      id: createId("pkli"),
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      issueType: issue.issueType,
      severity: issue.severity,
      title: issue.title,
      message: issue.message,
      category: issue.category ?? null,
      entryKey: issue.entryKey ?? null,
      sourceWorkItemIds: JSON.stringify(issue.sourceWorkItemIds),
      issueFingerprint,
      lintRunId,
      createdAt: now,
      updatedAt: now,
    });
  }

  await sqlRun(
    `
      UPDATE project_knowledge_lint_issues
      SET status = 'resolved', resolved_at = @now, updated_at = @now
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND origin = 'deterministic' AND status = 'open'
        AND (
          COALESCE(array_length(@currentFingerprints::text[], 1), 0) = 0
          OR NOT (issue_fingerprint = ANY(@currentFingerprints::text[]))
        )
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      currentFingerprints,
      now,
    },
  );

  await sqlRun(
    `
      INSERT INTO project_knowledge_lint_runs (
        id, workspace_id, project_id, azure_project_id, issue_count,
        error_count, warning_count, started_at, completed_at
      ) VALUES (
        @id, (SELECT workspace_id FROM projects WHERE id = @projectId), @projectId,
        @azureProjectId, @issueCount, @errorCount, @warningCount, @startedAt, @completedAt
      )
    `,
    {
      id: lintRunId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      issueCount: issues.length,
      errorCount: issues.filter((issue) => issue.severity === "error").length,
      warningCount: issues.filter((issue) => issue.severity === "warning").length,
      startedAt: now,
      completedAt: nowIso(),
    },
  );

  recordProjectKnowledgeLog({
    scope,
    eventType: "knowledge.lint_completed",
    severity: issues.some((issue) => issue.severity === "error") ? "warning" : "info",
    title: "Knowledge lint completed",
    message: `Found ${issues.length} knowledge health issue${issues.length === 1 ? "" : "s"}.`,
    metadata: {
      issueCount: issues.length,
      errors: issues.filter((issue) => issue.severity === "error").length,
      warnings: issues.filter((issue) => issue.severity === "warning").length,
    },
  });

  return {
    runId: lintRunId,
    issues: await getProjectKnowledgeLintIssues({ scope }),
    summary: summarizeIssues(issues),
  };
}

export async function getProjectKnowledgeLintIssues(input: { scope: ProjectScope }): Promise<ProjectKnowledgeLintIssue[]> {
  const scope = assertProjectScope(input.scope);
  const rows = await sqlAll<KnowledgeLintRow>(
    `
      SELECT id, issue_type, severity, title, message, category, entry_key,
             source_work_item_ids, status, origin, created_at, updated_at
      FROM project_knowledge_lint_issues
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY
        CASE severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        created_at DESC
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );

  return rows.map((row) => ({
    id: row.id,
    issueType: row.issue_type,
    severity: row.severity,
    title: row.title,
    message: row.message,
    category: row.category,
    entryKey: row.entry_key,
    sourceWorkItemIds: parseJsonArray(row.source_work_item_ids),
    status: row.status,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function exportProjectKnowledgeWiki(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  const snapshot = await getActiveKnowledgeSnapshot(scope);
  if (!snapshot) {
    throw new Error("Extract the project knowledge base before exporting the knowledge wiki.");
  }

  const knowledgeBase = JSON.parse(snapshot.validated_output) as ProjectKnowledgeBase;
  const logs = await getProjectKnowledgeLog({ scope, limit: 500 });
  const benchmark = await listProjectKnowledgeBenchmarkCases({ scope, limit: 500 });
  const fs = getFs();
  const path = getPath();
  const exportRoot = path.join(
    process.cwd(),
    "data",
    "knowledge-wiki",
    safePathSegment(scope.projectId),
  );

  fs.mkdirSync(exportRoot, { recursive: true });
  cleanupManifestOwnedExportFiles(exportRoot);
  for (const folder of ["modules", "business-rules", "state-transitions", "glossary", "dependencies"]) {
    fs.mkdirSync(path.join(exportRoot, folder), { recursive: true });
  }

  fs.writeFileSync(path.join(exportRoot, "index.md"), renderWikiIndex(scope, knowledgeBase, snapshot), "utf8");
  fs.writeFileSync(path.join(exportRoot, "log.md"), renderWikiLog(logs), "utf8");
  fs.writeFileSync(path.join(exportRoot, "map.md"), renderWikiMap(knowledgeBase), "utf8");
  fs.writeFileSync(
    path.join(exportRoot, "benchmark.jsonl"),
    benchmark.map((item) => JSON.stringify({
      id: item.id,
      sourceType: item.sourceType,
      question: item.question,
      usageCount: item.usageCount,
    })).join("\n") + (benchmark.length ? "\n" : ""),
    "utf8",
  );
  const generatedFiles = ["benchmark.jsonl", "index.md", "log.md", "map.md"];

  knowledgeBase.modules.forEach((item) => {
    generatedFiles.push(`modules/${safePathSegment(item.id)}.md`);
    writeWikiPage(exportRoot, "modules", item.id, renderWikiPage({
      title: item.name,
      category: "module",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [item.description].filter(Boolean).join("\n\n"),
    }));
  });
  knowledgeBase.businessRules.forEach((item) => {
    generatedFiles.push(`business-rules/${safePathSegment(item.id)}.md`);
    writeWikiPage(exportRoot, "business-rules", item.id, renderWikiPage({
      title: item.rule,
      category: "business_rule",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [
        item.moduleName ? `Module: ${item.moduleName}` : "",
        `Source field: ${item.sourceField}`,
      ].filter(Boolean).join("\n\n"),
    }));
  });
  knowledgeBase.stateTransitions.forEach((item) => {
    generatedFiles.push(`state-transitions/${safePathSegment(item.id)}.md`);
    writeWikiPage(exportRoot, "state-transitions", item.id, renderWikiPage({
      title: item.workflowName,
      category: "state_transition",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [
        item.fromState || item.toState ? `Transition: ${item.fromState ?? "unspecified"} -> ${item.toState ?? "unspecified"}` : "",
        `Trigger or condition: ${item.triggerOrCondition}`,
        item.actor ? `Actor: ${item.actor}` : "",
        item.moduleName ? `Module: ${item.moduleName}` : "",
      ].filter(Boolean).join("\n\n"),
    }));
  });
  knowledgeBase.glossary.forEach((item) => {
    generatedFiles.push(`glossary/${safePathSegment(item.term)}.md`);
    writeWikiPage(exportRoot, "glossary", item.term, renderWikiPage({
      title: item.term,
      category: "glossary",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [`Type: ${item.type}`, item.definition].join("\n\n"),
    }));
  });
  knowledgeBase.crossDependencies.forEach((item) => {
    generatedFiles.push(`dependencies/${safePathSegment(item.id)}.md`);
    writeWikiPage(exportRoot, "dependencies", item.id, renderWikiPage({
      title: `${item.sourceModule} -> ${item.targetModule}`,
      category: "dependency",
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      body: [`Type: ${item.dependencyType}`, item.description].join("\n\n"),
    }));
  });

  fs.writeFileSync(path.join(exportRoot, ".itestflow-manifest.json"), JSON.stringify({
    version: 1,
    projectId: scope.projectId,
    generatedAt: nowIso(),
    files: generatedFiles.sort(),
  }, null, 2), "utf8");

  recordProjectKnowledgeLog({
    scope,
    eventType: "knowledge.exported",
    severity: "info",
    title: "Exported knowledge wiki",
    message: `Exported the compiled project knowledge wiki to ${exportRoot}.`,
    metadata: { exportRoot },
  });

  return {
    exportRoot,
    fileCount:
      5 +
      knowledgeBase.modules.length +
      knowledgeBase.businessRules.length +
      knowledgeBase.stateTransitions.length +
      knowledgeBase.glossary.length +
      knowledgeBase.crossDependencies.length,
  };
}

export async function promoteContextChatbotAnswer(input: {
  scope: ProjectScope;
  actor?: string;
  answer: string;
  citations: Array<{
    sourceId: string;
    sourceType: "project_context" | "project_knowledge";
    workItemId?: string;
    sourceWorkItemIds?: string[];
  }>;
}) {
  const scope = assertProjectScope(input.scope);
  const answer = input.answer.trim();
  if (!answer) throw new Error("Cannot promote an empty chatbot answer.");
  if (!input.citations.length) throw new Error("Promoted knowledge must be backed by at least one local citation.");

  const sourceIds = Array.from(
    new Set(
      input.citations.flatMap((citation) => [
        citation.workItemId,
        ...(citation.sourceWorkItemIds ?? []),
        citation.sourceId.startsWith("WI:") ? citation.sourceId.slice(3) : undefined,
      ]).filter((value): value is string => Boolean(value)),
    ),
  );
  if (!sourceIds.length) throw new Error("Promoted knowledge must cite at least one source work item.");

  const now = nowIso();
  // A cited synthesis is not a source quote. Keep it ungrounded until every
  // fragment can be uniquely re-anchored to immutable snapshot fields.
  const grounded = false;
  const id = createId("pkc");
  const entryKey = `chat-insight-${stableHash(answer).slice(0, 12)}`;

  await sqlRun(
    `
    INSERT INTO project_knowledge_candidates (
      id, workspace_id, project_id, azure_project_id, azure_project_name,
      azure_organization_url, title, content, status, source_work_item_ids,
      evidence_refs_json, citations_json, created_by, created_at, updated_at
    ) VALUES (
      @id, (SELECT workspace_id FROM projects WHERE id = @projectId), @projectId,
      @azureProjectId, @azureProjectName, @azureOrganizationUrl, @title, @content,
      @status, @sourceWorkItemIds, @evidenceRefsJson, @citationsJson,
      @createdBy, @createdAt, @updatedAt
    )
  `,
    {
      id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      title: answer.split(/\s+/).slice(0, 12).join(" "),
      content: answer,
      status: grounded ? "grounded" : "legacy_ungrounded",
      sourceWorkItemIds: JSON.stringify(sourceIds),
      evidenceRefsJson: "[]",
      citationsJson: JSON.stringify(input.citations),
      createdBy: input.actor ?? null,
      createdAt: now,
      updatedAt: now,
    },
  );

  recordProjectKnowledgeLog({
    scope,
    eventType: "knowledge.chat_insight_promoted",
    severity: "info",
    title: "Saved chatbot answer as candidate knowledge",
    message: "A cited Context Chatbot answer was saved to the knowledge log for review.",
    sourceIds,
    metadata: { candidateId: id, entryKey, grounded },
  });

  return { candidateId: id, entryKey, sourceIds, status: grounded ? "grounded" : "legacy_ungrounded" };
}

export async function reportProjectKnowledgeLintMiss(input: {
  scope: ProjectScope;
  actor: string;
  missType: "duplicate" | "conflict";
  title: string;
  message: string;
  category?: string;
  entryKey?: string;
  sourceWorkItemIds?: string[];
}) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  const fingerprint = stableHash(JSON.stringify({
    origin: "human",
    missType: input.missType,
    category: input.category ?? null,
    entryKey: input.entryKey ? normalizeKey(input.entryKey) : null,
    message: normalizeKey(input.message),
  }));
  const id = createId("pkli");
  const latestRun = await sqlGet<{ id: string }>(
    `
      SELECT id FROM project_knowledge_lint_runs
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
      ORDER BY completed_at DESC LIMIT 1
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
  );
  const lintRunId = latestRun?.id ?? null;
  await sqlRun(
    `
      INSERT INTO project_knowledge_lint_issues (
        id, project_id, azure_project_id, azure_project_name, azure_organization_url,
        issue_type, severity, title, message, category, entry_key,
        source_work_item_ids, status, created_at, updated_at, issue_fingerprint,
        origin, first_seen_at, last_seen_at, resolution_json, lint_run_id
      ) VALUES (
        @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
        @issueType, 'warning', @title, @message, @category, @entryKey,
        @sourceWorkItemIds, 'reported', @createdAt, @updatedAt, @issueFingerprint,
        'human', @createdAt, @updatedAt, @resolutionJson, @lintRunId
      )
      ON CONFLICT (project_id, azure_project_id, issue_fingerprint)
        WHERE issue_fingerprint IS NOT NULL
      DO UPDATE SET last_seen_at = EXCLUDED.last_seen_at,
                    lint_run_id = EXCLUDED.lint_run_id,
                    updated_at = EXCLUDED.updated_at
    `,
    {
      id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      issueType: `reported_missed_${input.missType}`,
      title: input.title.trim(),
      message: input.message.trim(),
      category: input.category ?? null,
      entryKey: input.entryKey ?? null,
      sourceWorkItemIds: JSON.stringify(input.sourceWorkItemIds ?? []),
      issueFingerprint: fingerprint,
      resolutionJson: JSON.stringify({ reportedBy: input.actor }),
      lintRunId,
      createdAt: now,
      updatedAt: now,
    },
  );
  return getProjectKnowledgeLintIssues({ scope });
}

export async function transitionProjectKnowledgeLintIssue(input: {
  scope: ProjectScope;
  actor: string;
  issueId: string;
  action: "confirm" | "reject" | "ignore" | "reopen";
  note?: string;
}) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  const updated = await sqlRun(
    `
      UPDATE project_knowledge_lint_issues
      SET status = CASE
            WHEN @action = 'confirm' THEN 'confirmed'
            WHEN @action = 'reject' THEN 'rejected'
            WHEN @action = 'ignore' THEN 'ignored'
            WHEN origin = 'human' THEN 'reported'
            ELSE 'open'
          END,
          confirmed_by = CASE WHEN @action = 'confirm' THEN @actor ELSE NULL END,
          confirmed_at = CASE WHEN @action = 'confirm' THEN @now ELSE NULL END,
          resolution_json = @resolutionJson,
          resolved_at = CASE WHEN @action = 'reopen' THEN NULL ELSE @now END,
          updated_at = @now
      WHERE id = @issueId AND project_id = @projectId AND azure_project_id = @azureProjectId
        AND (
          (@action IN ('confirm', 'reject') AND origin = 'human' AND status = 'reported')
          OR (@action = 'ignore' AND origin = 'deterministic' AND status = 'open')
          OR (@action = 'reopen' AND (
            (origin = 'deterministic' AND status IN ('ignored', 'resolved'))
            OR (origin = 'human' AND status IN ('confirmed', 'rejected'))
          ))
        )
    `,
    {
      issueId: input.issueId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      action: input.action,
      actor: input.actor,
      now,
      resolutionJson: JSON.stringify({ action: input.action, note: input.note ?? null, reviewedBy: input.actor }),
    },
  );
  if (!updated) {
    const existing = await sqlGet<{ id: string }>(
      `
        SELECT id FROM project_knowledge_lint_issues
        WHERE id = @issueId AND project_id = @projectId AND azure_project_id = @azureProjectId
      `,
      { issueId: input.issueId, projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    );
    if (!existing) throw resourceNotFound("Project knowledge lint issue");
    throw new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "The lint issue action is invalid for its origin or current status.",
      userMessage: "This lint issue changed or does not support the requested action. Refresh and try again.",
    });
  }
  return getProjectKnowledgeLintIssues({ scope });
}

export async function listProjectKnowledgeCandidates(input: {
  scope: ProjectScope;
  status?: ProjectKnowledgeCandidateStatus;
  limit?: number;
}) {
  const scope = assertProjectScope(input.scope);
  const rows = await sqlAll<KnowledgeCandidateRow>(
    `
      SELECT id, title, content, status, source_work_item_ids, evidence_refs_json,
             citations_json, rejected_reason, created_at, updated_at
      FROM project_knowledge_candidates
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND (@status::text IS NULL OR status = @status)
      ORDER BY updated_at DESC
      LIMIT @limit
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      status: input.status ?? null,
      limit: Math.min(100, Math.max(1, input.limit ?? 50)),
    },
  );
  return rows.map(toKnowledgeCandidate);
}

export async function getProjectKnowledgeCandidate(input: { scope: ProjectScope; candidateId: string }) {
  const scope = assertProjectScope(input.scope);
  const row = await sqlGet<KnowledgeCandidateRow>(
    `
      SELECT id, title, content, status, source_work_item_ids, evidence_refs_json,
             citations_json, rejected_reason, created_at, updated_at
      FROM project_knowledge_candidates
      WHERE id = @candidateId AND project_id = @projectId AND azure_project_id = @azureProjectId
      LIMIT 1
    `,
    {
      candidateId: input.candidateId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );
  return row ? toKnowledgeCandidate(row) : null;
}

export async function rejectProjectKnowledgeCandidate(input: {
  scope: ProjectScope;
  candidateId: string;
  actor: string;
  reason: string;
}) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  const updated = await sqlRun(
    `
      UPDATE project_knowledge_candidates
      SET status = 'rejected', rejected_by = @actor, rejected_reason = @reason,
          rejected_at = @now, updated_at = @now
      WHERE id = @candidateId AND project_id = @projectId AND azure_project_id = @azureProjectId
        AND status <> 'rejected'
    `,
    {
      candidateId: input.candidateId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      actor: input.actor,
      reason: input.reason.trim().slice(0, 1000),
      now,
    },
  );
  if (!updated) {
    const existing = await getProjectKnowledgeCandidate({ scope, candidateId: input.candidateId });
    if (!existing) throw resourceNotFound("Project knowledge candidate");
    throw new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "The candidate is already rejected.",
      userMessage: "This candidate has already been rejected.",
    });
  }
  return getProjectKnowledgeCandidate({ scope, candidateId: input.candidateId });
}

export async function requestProjectKnowledgeCandidateIntegration(input: {
  scope: ProjectScope;
  candidateId: string;
  actor: string;
}) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  const updated = await sqlRun(
    `
      UPDATE project_knowledge_candidates
      SET status = 'integration_requested', integration_requested_by = @actor,
          integration_requested_at = @now, updated_at = @now
      WHERE id = @candidateId AND project_id = @projectId AND azure_project_id = @azureProjectId
        AND status = 'grounded'
    `,
    {
      candidateId: input.candidateId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      actor: input.actor,
      now,
    },
  );
  if (!updated) {
    const existing = await getProjectKnowledgeCandidate({ scope, candidateId: input.candidateId });
    if (!existing) throw resourceNotFound("Project knowledge candidate");
    throw new AppError({
      code: AppErrorCode.KnowledgeDraftConflict,
      message: "The candidate must be grounded before integration can be requested.",
      userMessage: "Only a grounded candidate can request integration.",
    });
  }
  return getProjectKnowledgeCandidate({ scope, candidateId: input.candidateId });
}

export async function regroundLegacyProjectKnowledgeCandidates(scopeInput: ProjectScope, client?: PoolClient) {
  const scope = assertProjectScope(scopeInput);
  const candidates = await sqlAll<{
    id: string;
    source_work_item_ids: unknown;
    citations_json: unknown;
  }>(
    `
      SELECT id, source_work_item_ids, citations_json
      FROM project_knowledge_candidates
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND status = 'legacy_ungrounded'
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    client,
  );
  for (const candidate of candidates) {
    const sourceIds = parseUnknownArray(candidate.source_work_item_ids).filter((value): value is string => typeof value === "string");
    if (!sourceIds.length) continue;
    const snapshots = await sqlAll<{ id: string; azure_work_item_id: string; fields_json: unknown }>(
      `
        SELECT snapshots.id, snapshots.azure_work_item_id, snapshots.fields_json
        FROM azure_devops_work_items work_items
        JOIN azure_devops_work_item_snapshots snapshots ON snapshots.id = work_items.current_snapshot_id
        WHERE work_items.project_id = @projectId AND work_items.azure_project_id = @azureProjectId
          AND work_items.azure_work_item_id = ANY(@sourceIds::text[])
          AND COALESCE(work_items.sync_status, 'active') = 'active'
      `,
      { projectId: scope.projectId, azureProjectId: scope.azureProjectId, sourceIds },
      client,
    );
    if (new Set(snapshots.map((snapshot) => snapshot.azure_work_item_id)).size !== new Set(sourceIds).size) continue;
    const legacyEvidence = parseUnknownObject(candidate.citations_json).legacyEvidence;
    if (typeof legacyEvidence !== "string" || !legacyEvidence.trim()) continue;
    const fragments = legacyEvidence.split(/\s+\|\s+/).map((fragment) => fragment.trim()).filter(Boolean);
    const evidenceSnapshots = snapshots.map((snapshot) => ({
      id: snapshot.id,
      azure_work_item_id: snapshot.azure_work_item_id,
      fields_json: snapshot.fields_json,
    }));
    const resolved = fragments.map((quote) => ({
      quote,
      match: matchLegacyEvidenceFragmentUniquely(evidenceSnapshots, quote),
    }));
    if (!fragments.length || resolved.some((item) => !item.match)) continue;
    if (new Set(resolved.map((item) => item.match!.sourceWorkItemId)).size !== new Set(sourceIds).size) continue;
    await sqlRun(
      `
        UPDATE project_knowledge_candidates
        SET status = 'grounded', evidence_refs_json = @evidenceRefsJson, updated_at = @now
        WHERE id = @candidateId AND status = 'legacy_ungrounded'
      `,
      {
        candidateId: candidate.id,
        evidenceRefsJson: JSON.stringify(resolved.map(({ quote, match }) => ({
          sourceSnapshotId: match!.snapshotId,
          sourceWorkItemId: match!.sourceWorkItemId,
          sourceField: match!.sourceField,
          quote,
          origin: "migrated_legacy",
          verification: match!.verification,
        }))),
        now: nowIso(),
      },
      client,
    );
  }
}

async function nextRevisionNumber(scope: ProjectScope, client?: PoolClient) {
  const row = await sqlGet<{ revision_number: number | null }>(
    `
      SELECT MAX(revision_number) AS revision_number
      FROM project_knowledge_revisions
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
    client,
  );
  return (row?.revision_number ?? 0) + 1;
}

async function getActiveKnowledgeSnapshot(scope: ProjectScope) {
  return sqlGet<KnowledgeSnapshotRow>(
    `
      SELECT id, provider, model_name, source_work_item_count, raw_output, validated_output
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
}

function loadSourceWorkItems(scope: ProjectScope) {
  return sqlAll<SourceWorkItemRow>(
    `
      SELECT azure_work_item_id, title, COALESCE(sync_status, 'active') AS sync_status
      FROM azure_devops_work_items
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );
}

function addDuplicateEntryKeyIssues(
  entries: KnowledgeEntry[],
  issues: Array<Omit<ProjectKnowledgeLintIssue, "id" | "createdAt" | "updatedAt" | "status" | "origin">>,
) {
  const grouped = new Map<string, KnowledgeEntry[]>();
  entries.forEach((entry) => {
    const key = knowledgeVersionKey(entry.category, entry.entryKey);
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  });

  grouped.forEach((items, key) => {
    if (items.length < 2) return;
    issues.push({
      issueType: "duplicate_entry",
      severity: "warning",
      title: `Duplicate knowledge entry ${key}`,
      message: "Multiple compiled entries share the same category and key.",
      category: items[0].category,
      entryKey: items[0].entryKey,
      sourceWorkItemIds: Array.from(new Set(items.flatMap((item) => item.sourceWorkItemIds))),
    });
  });
}

function addNameSimilarityIssues(
  knowledgeBase: ProjectKnowledgeBase,
  issues: Array<Omit<ProjectKnowledgeLintIssue, "id" | "createdAt" | "updatedAt" | "status" | "origin">>,
) {
  const names = [
    ...knowledgeBase.modules.map((entry) => ({
      category: "module",
      entryKey: entry.id,
      name: entry.name,
      sourceWorkItemIds: entry.sourceWorkItemIds,
    })),
    ...knowledgeBase.glossary.map((entry) => ({
      category: "glossary",
      entryKey: entry.term,
      name: entry.term,
      sourceWorkItemIds: entry.sourceWorkItemIds,
    })),
  ];
  for (let firstIndex = 0; firstIndex < names.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < names.length; secondIndex += 1) {
      const first = names[firstIndex];
      const second = names[secondIndex];
      const firstKey = similarityKey(first.name);
      const secondKey = similarityKey(second.name);
      if (firstKey === secondKey || !areNamesSimilar(firstKey, secondKey)) continue;
      issues.push({
        issueType: "similar_name",
        severity: "warning",
        title: `Potential duplicate names: ${first.name} / ${second.name}`,
        message: "Canonical name similarity indicates that these entries may represent the same subject. Review before merging.",
        category: first.category === second.category ? first.category : "cross_category",
        entryKey: [first.entryKey, second.entryKey].sort().join(" | "),
        sourceWorkItemIds: Array.from(new Set([...first.sourceWorkItemIds, ...second.sourceWorkItemIds])),
      });
    }
  }
}

function similarityKey(value: string) {
  return normalizeKey(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(the|a|an|module|system|service)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function areNamesSimilar(first: string, second: string) {
  if (first.length < 5 || second.length < 5) return false;
  if (first.includes(second) || second.includes(first)) return true;
  const firstWords = new Set(first.split(" "));
  const secondWords = new Set(second.split(" "));
  const overlap = Array.from(firstWords).filter((word) => secondWords.has(word)).length;
  return overlap >= 2 && overlap / Math.max(firstWords.size, secondWords.size) >= 0.66;
}

function flattenProjectKnowledge(knowledgeBase: ProjectKnowledgeBase): KnowledgeEntry[] {
  const provenance = (item: {
    sourceWorkItemIds: string[];
    evidence: string;
    evidenceRefs?: ProjectKnowledgeEvidenceRef[];
  }) => {
    const evidenceRefs = item.evidenceRefs ?? [];
    return {
      sourceWorkItemIds: evidenceRefs.length
        ? Array.from(new Set(evidenceRefs.map((ref) => ref.sourceWorkItemId)))
        : item.sourceWorkItemIds,
      evidence: evidenceRefs.length ? renderProjectKnowledgeEvidenceRefs(evidenceRefs) : item.evidence,
      evidenceRefs,
    };
  };

  return [
    ...knowledgeBase.modules.map((item) => ({
      category: "module",
      entryKey: item.id,
      title: item.name,
      content: item.description,
      ...provenance(item),
      metadata: item,
    })),
    ...knowledgeBase.businessRules.map((item) => ({
      category: "business_rule",
      entryKey: item.id,
      title: item.rule,
      content: [item.rule, item.moduleName ? `Module: ${item.moduleName}` : "", `Source field: ${item.sourceField}`].filter(Boolean).join("\n"),
      ...provenance(item),
      metadata: item,
    })),
    ...knowledgeBase.stateTransitions.map((item) => ({
      category: "state_transition",
      entryKey: item.id,
      title: item.workflowName,
      content: [
        item.fromState || item.toState ? `Transition: ${item.fromState ?? "unspecified"} -> ${item.toState ?? "unspecified"}` : "",
        item.triggerOrCondition,
        item.actor ? `Actor: ${item.actor}` : "",
        item.moduleName ? `Module: ${item.moduleName}` : "",
      ].filter(Boolean).join("\n"),
      ...provenance(item),
      metadata: item,
    })),
    ...knowledgeBase.glossary.map((item) => ({
      category: "glossary",
      entryKey: item.term,
      title: item.term,
      content: [`Type: ${item.type}`, item.definition].join("\n"),
      ...provenance(item),
      metadata: item,
    })),
    ...knowledgeBase.crossDependencies.map((item) => ({
      category: "dependency",
      entryKey: item.id,
      title: `${item.sourceModule} -> ${item.targetModule}`,
      content: [`Type: ${item.dependencyType}`, item.description].join("\n"),
      ...provenance(item),
      metadata: item,
    })),
  ];
}

function summarizeIssues(issues: Array<{ severity: ProjectKnowledgeLogSeverity }>) {
  return {
    total: issues.length,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
    info: issues.filter((issue) => issue.severity === "info").length,
  };
}

function writeWikiPage(exportRoot: string, folder: string, slug: string, content: string) {
  getFs().writeFileSync(getPath().join(exportRoot, folder, `${safePathSegment(slug)}.md`), content, "utf8");
}

function renderWikiIndex(scope: ProjectScope, knowledgeBase: ProjectKnowledgeBase, snapshot: KnowledgeSnapshotRow) {
  return [
    "---",
    `project: ${yamlString(scope.azureProjectName)}`,
    `azureProjectId: ${yamlString(scope.azureProjectId)}`,
    `knowledgeBaseId: ${yamlString(snapshot.id)}`,
    `sourceWorkItemCount: ${snapshot.source_work_item_count}`,
    "---",
    "",
    `# ${scope.azureProjectName} Knowledge Wiki`,
    "",
    "## Categories",
    `- Modules: ${knowledgeBase.modules.length}`,
    `- Business rules: ${knowledgeBase.businessRules.length}`,
    `- State transitions: ${knowledgeBase.stateTransitions.length}`,
    `- Glossary: ${knowledgeBase.glossary.length}`,
    `- Dependencies: ${knowledgeBase.crossDependencies.length}`,
    "",
    "## Operating Principle",
    "Raw Azure DevOps work items remain the source of truth. These pages are compiled, source-cited knowledge for navigation, QA analysis, and review.",
  ].join("\n");
}

function renderWikiLog(logs: ProjectKnowledgeLogItem[]) {
  return [
    "# Knowledge Log",
    "",
    ...logs.map((log) => [
      `## ${log.createdAt} - ${log.title}`,
      "",
      `- Type: ${log.eventType}`,
      `- Severity: ${log.severity}`,
      log.sourceIds.length ? `- Sources: ${log.sourceIds.join(", ")}` : "",
      "",
      log.message,
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function toKnowledgeCandidate(row: KnowledgeCandidateRow) {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    status: row.status,
    sourceWorkItemIds: parseUnknownArray(row.source_work_item_ids),
    evidenceRefs: parseUnknownArray(row.evidence_refs_json),
    citations: parseUnknownArray(row.citations_json),
    rejectedReason: row.rejected_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function resourceNotFound(resource: string) {
  return new AppError({
    code: AppErrorCode.ResourceNotFound,
    message: `${resource} was not found in the active project.`,
    userMessage: `${resource} was not found.`,
  });
}

function renderWikiMap(knowledgeBase: ProjectKnowledgeBase) {
  const lines = ["# Dense Knowledge Map", ""];
  const section = (title: string, entries: Array<{ label: string; path: string; sources: string[] }>) => {
    lines.push(`## ${title}`, "");
    if (!entries.length) lines.push("No entries.", "");
    else entries.forEach((entry) => lines.push(`- [${entry.label}](${entry.path}) - sources: ${entry.sources.join(", ")}`));
    lines.push("");
  };
  section("Modules", knowledgeBase.modules.map((entry) => ({
    label: entry.name,
    path: `modules/${safePathSegment(entry.id)}.md`,
    sources: entry.sourceWorkItemIds,
  })));
  section("Business Rules", knowledgeBase.businessRules.map((entry) => ({
    label: entry.rule,
    path: `business-rules/${safePathSegment(entry.id)}.md`,
    sources: entry.sourceWorkItemIds,
  })));
  section("State Transitions", knowledgeBase.stateTransitions.map((entry) => ({
    label: entry.workflowName,
    path: `state-transitions/${safePathSegment(entry.id)}.md`,
    sources: entry.sourceWorkItemIds,
  })));
  section("Glossary", knowledgeBase.glossary.map((entry) => ({
    label: entry.term,
    path: `glossary/${safePathSegment(entry.term)}.md`,
    sources: entry.sourceWorkItemIds,
  })));
  section("Dependencies", knowledgeBase.crossDependencies.map((entry) => ({
    label: `${entry.sourceModule} -> ${entry.targetModule}`,
    path: `dependencies/${safePathSegment(entry.id)}.md`,
    sources: entry.sourceWorkItemIds,
  })));
  return lines.join("\n").trimEnd();
}

function cleanupManifestOwnedExportFiles(exportRoot: string) {
  const fs = getFs();
  const path = getPath();
  const manifestPath = path.join(exportRoot, ".itestflow-manifest.json");
  if (!fs.existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { files?: unknown };
    if (!Array.isArray(manifest.files)) return;
    const root = path.resolve(exportRoot);
    for (const relativePath of manifest.files) {
      if (typeof relativePath !== "string") continue;
      const target = path.resolve(root, relativePath);
      if (!target.startsWith(`${root}${path.sep}`) || !fs.existsSync(target)) continue;
      if (fs.statSync(target).isFile()) fs.unlinkSync(target);
    }
  } catch (error) {
    console.warn("Knowledge export manifest could not be read; preserving existing files.", error);
  }
}

function renderWikiPage(input: {
  title: string;
  category: string;
  sourceWorkItemIds: string[];
  evidence: string;
  body: string;
}) {
  return [
    "---",
    `title: ${yamlString(input.title)}`,
    `category: ${yamlString(input.category)}`,
    "status: active",
    `sourceWorkItemIds: [${input.sourceWorkItemIds.map(yamlString).join(", ")}]`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.body,
    "",
    "## Evidence",
    input.evidence,
  ].join("\n");
}

function safePathSegment(value: string) {
  const slug = value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "knowledge";
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

type ModuleNameEntry = {
  name: string;
  key: string;
  words: string[];
};

function buildModuleNameIndex(modules: ProjectKnowledgeBase["modules"]): ModuleNameEntry[] {
  return modules.map((module) => {
    const key = normalizeKey(module.name);
    return { name: module.name, key, words: tokenizeKey(key) };
  });
}

function isKnownModuleName(moduleName: string, moduleIndex: ModuleNameEntry[]) {
  return Boolean(resolveModuleName(moduleName, moduleIndex));
}

function resolveModuleName(moduleName: string, moduleIndex: ModuleNameEntry[]) {
  const key = normalizeKey(moduleName);
  const exact = moduleIndex.find((entry) => entry.key === key);
  if (exact) return exact;

  // Tolerate a trailing step or parenthetical qualifier, e.g. "Policy Summary (Step 5)" -> "Policy Summary".
  const baseKey = normalizeKey(stripModuleQualifier(moduleName));
  if (baseKey && baseKey !== key) {
    const baseExact = moduleIndex.find((entry) => entry.key === baseKey);
    if (baseExact) return baseExact;
  }

  // Tolerate a name that is a word-boundary prefix of (or extends) exactly one module,
  // e.g. "Terms & Conditions" -> "Terms & Conditions Acceptance". Ambiguous matches stay unresolved.
  return matchModuleByContainment(tokenizeKey(baseKey || key), moduleIndex);
}

function stripModuleQualifier(value: string) {
  const withoutParens = value.trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
  return getWorkflowStepParentEndpoint(withoutParens) ?? withoutParens;
}

function matchModuleByContainment(referenceWords: string[], moduleIndex: ModuleNameEntry[]) {
  if (referenceWords.length < 2) return null;
  const candidates = moduleIndex.filter(
    (entry) =>
      entry.words.length >= 2 && (isWordPrefix(referenceWords, entry.words) || isWordPrefix(entry.words, referenceWords)),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function matchEndpointByContainment(endpointKey: string, knownEndpoints: KnownDependencyEndpoint[], oppositeKey: string) {
  const referenceWords = tokenizeKey(endpointKey);
  if (referenceWords.length < 2) return null;
  const candidates = knownEndpoints.filter((candidate) => {
    if (candidate.key === oppositeKey) return false;
    const words = tokenizeKey(candidate.key);
    return words.length >= 2 && (isWordPrefix(referenceWords, words) || isWordPrefix(words, referenceWords));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function tokenizeKey(key: string) {
  return key.split(/\s+/).filter(Boolean);
}

// True when `shorter` is a strict, word-for-word leading prefix of `longer`.
function isWordPrefix(shorter: string[], longer: string[]) {
  if (!shorter.length || shorter.length >= longer.length) return false;
  return shorter.every((word, index) => word === longer[index]);
}

type KnownDependencyEndpoint = {
  name: string;
  key: string;
  slug: string;
  priority: number;
};

function buildKnownDependencyEndpoints(knowledgeBase: ProjectKnowledgeBase) {
  const endpoints = new Map<string, KnownDependencyEndpoint>();
  const addEndpoint = (name: string | undefined, priority: number) => {
    const trimmed = name?.trim();
    if (!trimmed) return;
    const key = normalizeKey(trimmed);
    const existing = endpoints.get(key);
    if (existing && existing.priority <= priority) return;
    endpoints.set(key, {
      name: trimmed,
      key,
      slug: slugKey(trimmed),
      priority,
    });
  };

  knowledgeBase.modules.forEach((module) => addEndpoint(module.name, 1));
  knowledgeBase.glossary.forEach((term) => addEndpoint(term.term, 2));
  knowledgeBase.stateTransitions.forEach((transition) => {
    addEndpoint(transition.workflowName, 3);
    addEndpoint(transition.moduleName, 3);
  });

  return Array.from(endpoints.values());
}

function isKnownDependencyEndpoint(
  endpoint: string,
  knownEndpoints: KnownDependencyEndpoint[],
  dependency: ProjectKnowledgeBase["crossDependencies"][number],
  oppositeEndpoint: string,
) {
  return Boolean(resolveKnownDependencyEndpoint(endpoint, knownEndpoints, dependency, oppositeEndpoint));
}

function resolveKnownDependencyEndpoint(
  endpoint: string,
  knownEndpoints: KnownDependencyEndpoint[],
  dependency: ProjectKnowledgeBase["crossDependencies"][number],
  oppositeEndpoint: string,
) {
  const endpointKey = normalizeKey(endpoint);
  const exact = knownEndpoints.find((candidate) => candidate.key === endpointKey);
  if (exact) return exact;

  const workflowStepParent = getWorkflowStepParentEndpoint(endpoint);
  if (workflowStepParent) {
    const parentKey = normalizeKey(workflowStepParent);
    const parentExact = knownEndpoints.find((candidate) => candidate.key === parentKey);
    if (parentExact) return parentExact;

    const parentSlug = slugKey(workflowStepParent);
    const parentMatch = chooseBestDependencyEndpoint(
      knownEndpoints.filter((candidate) => endpointMatchesAlias(candidate, parentKey, parentSlug)),
    );
    if (parentMatch) return parentMatch;
  }

  const dependencySlug = slugKey(dependency.id);
  const oppositeKey = normalizeKey(oppositeEndpoint);
  const idMatch = chooseBestDependencyEndpoint(
    knownEndpoints.filter((candidate) => candidate.key !== oppositeKey && dependencySlug.includes(candidate.slug)),
  );
  if (idMatch) return idMatch;

  // Tolerate an endpoint that is a word-boundary prefix of (or extends) exactly one known endpoint,
  // e.g. "Terms & Conditions" -> "Terms & Conditions Acceptance". Ambiguous matches stay unresolved.
  return matchEndpointByContainment(endpointKey, knownEndpoints, oppositeKey);
}

function endpointMatchesAlias(candidate: KnownDependencyEndpoint, aliasKey: string, aliasSlug: string) {
  if (aliasKey.length < 4 || aliasSlug.length < 4) return false;
  return candidate.key.includes(aliasKey) || candidate.slug.includes(aliasSlug);
}

function chooseBestDependencyEndpoint(candidates: KnownDependencyEndpoint[]) {
  return candidates
    .filter((candidate) => candidate.slug.length >= 4)
    .sort((first, second) => first.priority - second.priority || first.key.length - second.key.length)[0];
}

function getWorkflowStepParentEndpoint(endpoint: string) {
  const trimmed = endpoint.trim();
  const suffixMatch = trimmed.match(/^(.*?)\s+(?:workflow\s+)?step\s*#?\d+\.?\s*$/i);
  const suffixParent = suffixMatch?.[1] ? cleanWorkflowStepParent(suffixMatch[1]) : "";
  if (suffixParent) return suffixParent;

  const prefixMatch = trimmed.match(/^step\s*#?\d+\.?\s*[-:]\s*(.*?)$/i);
  const prefixParent = prefixMatch?.[1] ? cleanWorkflowStepParent(prefixMatch[1]) : "";
  if (prefixParent) return prefixParent;

  return null;
}

function cleanWorkflowStepParent(value: string) {
  return value.trim().replace(/[-:]+$/g, "").trim();
}

function slugKey(value: string) {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function isExternalOrReferenceDependencyEndpoint(endpoint: string, dependencyType: string) {
  const value = `${endpoint} ${dependencyType}`.toLowerCase();
  return /\b(external|link|links|url|urls|website|web|app|download|social|blog|support|api|integration|provider|service|services|lookup)\b/.test(value);
}

function knowledgeVersionKey(category: string, entryKey: string) {
  return `${category}:${normalizeKey(entryKey)}`;
}

function stableHash(value: string) {
  return getCrypto().createHash("sha256").update(value).digest("hex");
}

function parseJsonArray(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseUnknownArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseUnknownObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getFs() {
  return nativeRequire("fs") as FsModule;
}

function getPath() {
  return nativeRequire("path") as PathModule;
}

function getCrypto() {
  return nativeRequire("crypto") as CryptoModule;
}

function nativeRequire(specifier: string): unknown {
  const requireFunction = eval("require") as NodeRequire;
  return requireFunction(specifier);
}
