import "server-only";

import type { PoolClient } from "pg";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createId, nowIso, sqlAll, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  PROJECT_KNOWLEDGE_LEGACY_PROVENANCE_HASH_VERSION,
  PROJECT_KNOWLEDGE_LEGACY_SEMANTIC_HASH_VERSION,
  canonicalizeBusinessRuleSourceFieldForProjection,
  canonicalizeProjectKnowledgeKey,
  computeProjectKnowledgeHashes,
  hashCanonicalValue,
} from "./project-knowledge-contracts";
import {
  ProjectKnowledgeBaseSchema,
  ProjectKnowledgeBusinessRuleSchema,
  ProjectKnowledgeCrossDependencySchema,
  ProjectKnowledgeGlossaryTermSchema,
  ProjectKnowledgeModuleSchema,
  ProjectKnowledgeStateTransitionSchema,
  splitProjectKnowledgeLegacyEvidence,
} from "./project-knowledge.schema";

type LegacyVersionRow = {
  id: string;
  workspace_id: string;
  category: string;
  entry_key: string;
  title: string;
  content: string;
  source_work_item_ids: string;
  evidence: string;
  metadata_json: string | null;
};

type SnapshotRow = {
  id: string;
  azure_work_item_id: string;
  fields_json: unknown;
};

export type LegacyEvidenceSnapshot = SnapshotRow;

export function matchLegacyEvidenceFragmentUniquely(
  snapshots: LegacyEvidenceSnapshot[],
  fragment: string,
) {
  const matches = snapshots.flatMap((snapshot) => matchSnapshotFragment(snapshot, fragment));
  return matches.length === 1 ? matches[0] : null;
}

export async function backfillProjectKnowledgeCompilerFoundation(
  scopeInput: ProjectScope,
  client?: PoolClient,
) {
  const scope = assertProjectScope(scopeInput);
  const versions = await sqlAll<LegacyVersionRow>(
    `
      SELECT id, workspace_id, category, entry_key, title, content,
             source_work_item_ids, evidence, metadata_json
      FROM project_knowledge_entry_versions
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND (entry_semantic_hash IS NULL OR entry_provenance_hash IS NULL)
        AND status <> 'migrated'
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    client,
  );

  for (const version of versions) {
    const sourceIds = parseStringArray(version.source_work_item_ids);
    const parsed = parseLegacyProjectKnowledgeEntryForMigration(version);
    if (!parsed) {
      await recordMigrationIssue(scope, version, "legacy_entry_parse_failed", {
        category: version.category,
        entryKey: version.entry_key,
      }, client);
      continue;
    }
    const semanticHash = hashCanonicalValue(parsed.semanticProjection);
    const provenanceHash = hashCanonicalValue({
      legacyEvidence: version.evidence,
      sourceWorkItemIds: [...new Set(sourceIds)].sort(),
    });
    await sqlRun(
      `
        UPDATE project_knowledge_entry_versions
        SET entry_semantic_hash = @semanticHash,
            entry_provenance_hash = @provenanceHash,
            semantic_hash_version = @semanticHashVersion,
            provenance_hash_version = @provenanceHashVersion
        WHERE id = @id
      `,
      {
        id: version.id,
        semanticHash,
        provenanceHash,
        semanticHashVersion: PROJECT_KNOWLEDGE_LEGACY_SEMANTIC_HASH_VERSION,
        provenanceHashVersion: PROJECT_KNOWLEDGE_LEGACY_PROVENANCE_HASH_VERSION,
      },
      client,
    );
    await mapLegacyEvidenceRefs(scope, version, sourceIds, client);
  }

  const activeVersions = await sqlAll<LegacyVersionRow & {
    entry_semantic_hash: string | null;
    entry_provenance_hash: string | null;
    resolved_refs: number;
    provenance_hash_version: string | null;
  }>(
    `
      SELECT versions.id, versions.workspace_id, versions.category, versions.entry_key,
             versions.title, versions.content, versions.source_work_item_ids,
             versions.evidence, versions.metadata_json, versions.entry_semantic_hash,
             versions.entry_provenance_hash, versions.provenance_hash_version,
             COUNT(refs.id) FILTER (
               WHERE refs.verification IN ('exact', 'normalized', 'auto_reanchored')
             )::int AS resolved_refs
      FROM project_knowledge_entry_versions versions
      LEFT JOIN project_knowledge_entry_evidence_refs refs ON refs.entry_version_id = versions.id
      WHERE versions.project_id = @projectId AND versions.azure_project_id = @azureProjectId
        AND versions.status = 'active'
        AND versions.provenance_hash_version = @legacyProvenanceHashVersion
      GROUP BY versions.id
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      legacyProvenanceHashVersion: PROJECT_KNOWLEDGE_LEGACY_PROVENANCE_HASH_VERSION,
    },
    client,
  );
  for (const version of activeVersions) {
    const expectedFragments = splitProjectKnowledgeLegacyEvidence(version.evidence).length;
    const sourceIds = parseStringArray(version.source_work_item_ids);
    const snapshotCount = sourceIds.length
      ? await sqlAll<{ id: string }>(
          `
            SELECT id FROM azure_devops_work_item_snapshots
            WHERE project_id = @projectId AND azure_project_id = @azureProjectId
              AND azure_work_item_id = ANY(@sourceIds::text[])
            LIMIT 1
          `,
          { projectId: scope.projectId, azureProjectId: scope.azureProjectId, sourceIds },
          client,
        ).then((rows) => rows.length)
      : 0;
    const provenanceStatus = snapshotCount === 0
      ? "legacy_unknown"
      : version.resolved_refs === 0
        ? "legacy_unverified"
        : version.resolved_refs >= expectedFragments
          ? "verified"
          : "partial";
    await sqlRun(
      `
        UPDATE project_knowledge_entries
        SET entry_version_id = @entryVersionId,
            entry_semantic_hash = @entrySemanticHash,
            entry_provenance_hash = @entryProvenanceHash,
            provenance_status = @provenanceStatus
        WHERE project_id = @projectId AND azure_project_id = @azureProjectId
          AND category = @category
          AND lower(regexp_replace(entry_key, '\\s+', ' ', 'g')) =
              lower(regexp_replace(@entryKey, '\\s+', ' ', 'g'))
      `,
      {
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        entryVersionId: version.id,
        entrySemanticHash: version.entry_semantic_hash,
        entryProvenanceHash: version.entry_provenance_hash,
        provenanceStatus,
        category: version.category,
        entryKey: version.entry_key,
      },
      client,
    );
  }
  await sqlRun(
    `
      UPDATE project_knowledge_base knowledge
      SET provenance_status = CASE
        WHEN NOT EXISTS (
          SELECT 1 FROM project_knowledge_entries entries
          WHERE entries.project_id = knowledge.project_id AND entries.azure_project_id = knowledge.azure_project_id
        ) THEN 'legacy_unknown'
        WHEN NOT EXISTS (
          SELECT 1 FROM project_knowledge_entries entries
          WHERE entries.project_id = knowledge.project_id AND entries.azure_project_id = knowledge.azure_project_id
            AND entries.provenance_status <> 'legacy_unknown'
        ) THEN 'legacy_unknown'
        WHEN NOT EXISTS (
          SELECT 1 FROM project_knowledge_entries entries
          WHERE entries.project_id = knowledge.project_id AND entries.azure_project_id = knowledge.azure_project_id
            AND entries.provenance_status <> 'verified'
        ) THEN 'verified'
        WHEN EXISTS (
          SELECT 1 FROM project_knowledge_entries entries
          WHERE entries.project_id = knowledge.project_id AND entries.azure_project_id = knowledge.azure_project_id
            AND entries.provenance_status IN ('verified', 'partial')
        ) THEN 'partial'
        ELSE 'legacy_unverified'
      END
      WHERE knowledge.project_id = @projectId AND knowledge.azure_project_id = @azureProjectId
        AND knowledge.provenance_hash_version IS DISTINCT FROM @currentProvenanceHashVersion
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      currentProvenanceHashVersion: "provenance-v2",
    },
    client,
  );

  const knowledgeRows = await sqlAll<{ id: string; validated_output: string }>(
    `
      SELECT id, validated_output FROM project_knowledge_base
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
        AND (semantic_hash IS NULL OR provenance_hash IS NULL)
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    client,
  );
  for (const row of knowledgeRows) {
    try {
      const knowledgeBase = ProjectKnowledgeBaseSchema.parse(JSON.parse(row.validated_output));
      const hashes = computeProjectKnowledgeHashes(knowledgeBase);
      await sqlRun(
        `
          UPDATE project_knowledge_base
          SET semantic_hash = @semanticHash, provenance_hash = @provenanceHash,
              semantic_hash_version = @semanticHashVersion,
              provenance_hash_version = @provenanceHashVersion
          WHERE id = @id
        `,
        {
          id: row.id,
          semanticHash: hashes.semanticKnowledgeHash,
          provenanceHash: hashes.provenanceHash,
          semanticHashVersion: PROJECT_KNOWLEDGE_LEGACY_SEMANTIC_HASH_VERSION,
          provenanceHashVersion: PROJECT_KNOWLEDGE_LEGACY_PROVENANCE_HASH_VERSION,
        },
        client,
      );
    } catch (error) {
      await recordMigrationIssue(scope, { id: row.id, workspace_id: scope.workspaceId ?? "" }, "knowledge_base_parse_failed", {
        error: error instanceof Error ? error.message : String(error),
      }, client);
    }
  }
}

export function parseLegacyProjectKnowledgeEntryForMigration(
  version: Pick<LegacyVersionRow, "category" | "entry_key" | "title" | "content" | "metadata_json">,
) {
  const metadata = parseObject(version.metadata_json);
  const fromMetadata = parseTypedMetadata(version.category, metadata);
  const value = fromMetadata ?? parseFlattenedContent(version);
  if (!value) return null;
  return { semanticProjection: semanticProjection(version.category, value) };
}

function parseTypedMetadata(category: string, metadata: Record<string, unknown>) {
  if (!Object.keys(metadata).length) return null;
  const schema = category === "module"
    ? ProjectKnowledgeModuleSchema
    : category === "business_rule"
      ? ProjectKnowledgeBusinessRuleSchema
      : category === "state_transition"
        ? ProjectKnowledgeStateTransitionSchema
        : category === "glossary"
          ? ProjectKnowledgeGlossaryTermSchema
          : category === "dependency"
            ? ProjectKnowledgeCrossDependencySchema
            : null;
  if (!schema) return null;
  const result = schema.safeParse(metadata);
  return result.success ? result.data as Record<string, unknown> : null;
}

function parseFlattenedContent(
  version: Pick<LegacyVersionRow, "category" | "entry_key" | "title" | "content">,
): Record<string, unknown> | null {
  const lines = version.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const evidenceIndex = lines.findIndex((line) => /^Evidence:/i.test(line));
  const semanticLines = evidenceIndex >= 0 ? lines.slice(0, evidenceIndex) : lines;
  if (version.category === "module") {
    return { id: version.entry_key, name: version.title, description: semanticLines.join("\n") };
  }
  if (version.category === "business_rule") {
    if (hasDuplicatePrefix(semanticLines, "Module:") || hasDuplicatePrefix(semanticLines, "Source field:")) {
      return null;
    }
    const ruleLines = semanticLines.filter((line) => !/^(Module|Source field):/i.test(line));
    if (!ruleLines.length || semanticLines.some((line) => /^(Transition|Actor|Type):/i.test(line))) return null;
    return {
      id: version.entry_key,
      rule: ruleLines.join("\n"),
      moduleName: prefixedValue(semanticLines, "Module:"),
      sourceField: prefixedValue(semanticLines, "Source field:") ?? "metadata",
    };
  }
  if (version.category === "state_transition") {
    if (
      hasDuplicatePrefix(semanticLines, "Transition:") ||
      hasDuplicatePrefix(semanticLines, "Actor:") ||
      hasDuplicatePrefix(semanticLines, "Module:")
    ) return null;
    const transition = prefixedValue(semanticLines, "Transition:")?.split(/\s*->\s*/);
    if (transition && transition.length !== 2) return null;
    const triggerLines = semanticLines.filter((line) => !/^(Transition|Actor|Module):/i.test(line));
    if (!triggerLines.length || semanticLines.some((line) => /^Type:/i.test(line))) return null;
    return {
      id: version.entry_key,
      workflowName: version.title,
      fromState: transition?.[0] === "unspecified" ? undefined : transition?.[0],
      toState: transition?.[1] === "unspecified" ? undefined : transition?.[1],
      triggerOrCondition: triggerLines.join("\n"),
      actor: prefixedValue(semanticLines, "Actor:"),
      moduleName: prefixedValue(semanticLines, "Module:"),
    };
  }
  if (version.category === "glossary") {
    if (hasDuplicatePrefix(semanticLines, "Type:") || semanticLines.some((line) => /^(Transition|Actor|Module|Source field):/i.test(line))) {
      return null;
    }
    return {
      term: version.entry_key,
      type: prefixedValue(semanticLines, "Type:") ?? "term",
      definition: semanticLines.filter((line) => !/^Type:/i.test(line)).join("\n"),
    };
  }
  if (version.category === "dependency") {
    const endpoints = version.title.split(/\s*->\s*/);
    if (
      endpoints.length !== 2 ||
      endpoints.some((endpoint) => !endpoint.trim()) ||
      hasDuplicatePrefix(semanticLines, "Type:") ||
      semanticLines.some((line) => /^(Transition|Actor|Module|Source field):/i.test(line))
    ) return null;
    return {
      id: version.entry_key,
      sourceModule: endpoints[0],
      targetModule: endpoints[1],
      dependencyType: prefixedValue(semanticLines, "Type:") ?? "unknown",
      description: semanticLines.filter((line) => !/^Type:/i.test(line)).join("\n"),
    };
  }
  return null;
}

function semanticProjection(category: string, value: Record<string, unknown>) {
  const key = category === "glossary" ? String(value.term ?? "") : String(value.id ?? "");
  if (category === "module") return { category, canonicalKey: canonicalizeProjectKnowledgeKey(key), name: value.name, description: value.description ?? "" };
  if (category === "business_rule") return {
    category,
    canonicalKey: canonicalizeProjectKnowledgeKey(key),
    rule: value.rule,
    sourceField: canonicalizeBusinessRuleSourceFieldForProjection(String(value.sourceField ?? "")),
    moduleName: value.moduleName ?? null,
  };
  if (category === "state_transition") return {
    category,
    canonicalKey: canonicalizeProjectKnowledgeKey(key),
    workflowName: value.workflowName,
    fromState: value.fromState ?? null,
    toState: value.toState ?? null,
    triggerOrCondition: value.triggerOrCondition,
    actor: value.actor ?? null,
    moduleName: value.moduleName ?? null,
  };
  if (category === "glossary") return {
    category,
    canonicalKey: canonicalizeProjectKnowledgeKey(key),
    term: value.term,
    type: value.type,
    definition: value.definition,
  };
  return {
    category,
    canonicalKey: canonicalizeProjectKnowledgeKey(key),
    sourceModule: value.sourceModule,
    targetModule: value.targetModule,
    dependencyType: value.dependencyType,
    description: value.description ?? "",
  };
}

async function mapLegacyEvidenceRefs(
  scope: ProjectScope,
  version: LegacyVersionRow,
  sourceIds: string[],
  client?: PoolClient,
) {
  const snapshots = sourceIds.length
    ? await sqlAll<SnapshotRow>(
        `
          SELECT id, azure_work_item_id, fields_json
          FROM azure_devops_work_item_snapshots
          WHERE project_id = @projectId AND azure_project_id = @azureProjectId
            AND azure_work_item_id = ANY(@sourceIds::text[])
        `,
        { projectId: scope.projectId, azureProjectId: scope.azureProjectId, sourceIds },
        client,
      )
    : [];
  const fragments = splitProjectKnowledgeLegacyEvidence(version.evidence);
  let sortOrder = 0;
  for (const fragment of fragments) {
    const match = matchLegacyEvidenceFragmentUniquely(snapshots, fragment);
    if (!match) continue;
    await sqlRun(
      `
        INSERT INTO project_knowledge_entry_evidence_refs (
          id, workspace_id, project_id, azure_project_id, entry_version_id,
          source_snapshot_id, source_work_item_id, source_field, quote,
          origin, verification, sort_order, created_at
        ) VALUES (
          @id, @workspaceId, @projectId, @azureProjectId, @entryVersionId,
          @sourceSnapshotId, @sourceWorkItemId, @sourceField, @quote,
          'migrated_legacy', @verification, @sortOrder, @createdAt
        )
        ON CONFLICT DO NOTHING
      `,
      {
        id: `pkeref_${hashCanonicalValue({ entryVersionId: version.id, fragment }).slice(0, 32)}`,
        workspaceId: version.workspace_id,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        entryVersionId: version.id,
        sourceSnapshotId: match.snapshotId,
        sourceWorkItemId: match.sourceWorkItemId,
        sourceField: match.sourceField,
        quote: fragment,
        verification: match.verification,
        sortOrder,
        createdAt: nowIso(),
      },
      client,
    );
    sortOrder += 1;
  }
}

function matchSnapshotFragment(snapshot: SnapshotRow, fragment: string) {
  const fields = parseObject(snapshot.fields_json);
  return ["title", "description", "acceptanceCriteria", "state", "tags", "areaPath", "iterationPath", "metadata"]
    .flatMap((sourceField) => {
      const raw = fields[sourceField];
      const value = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw);
      if (!value) return [];
      if (value.includes(fragment)) return [{ snapshotId: snapshot.id, sourceWorkItemId: snapshot.azure_work_item_id, sourceField, verification: "exact" }];
      if (normalizeText(value).includes(normalizeText(fragment))) {
        return [{ snapshotId: snapshot.id, sourceWorkItemId: snapshot.azure_work_item_id, sourceField, verification: "normalized" }];
      }
      return [];
    });
}

async function recordMigrationIssue(
  scope: ProjectScope,
  entity: { id: string; workspace_id: string },
  issueType: string,
  details: Record<string, unknown>,
  client?: PoolClient,
) {
  await sqlRun(
    `
      INSERT INTO project_knowledge_migration_issues (
        id, workspace_id, project_id, azure_project_id, entity_type,
        entity_id, issue_type, details_json, created_at
      ) VALUES (
        @id, @workspaceId, @projectId, @azureProjectId, 'knowledge_entry_version',
        @entityId, @issueType, @detailsJson, @createdAt
      )
      ON CONFLICT (entity_type, entity_id, issue_type)
      DO UPDATE SET details_json = EXCLUDED.details_json
    `,
    {
      id: createId("pkmi"),
      workspaceId: entity.workspace_id || scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      entityId: entity.id,
      issueType,
      detailsJson: JSON.stringify(details),
      createdAt: nowIso(),
    },
    client,
  );
}

function prefixedValue(lines: string[], prefix: string) {
  return lines.find((line) => line.toLowerCase().startsWith(prefix.toLowerCase()))?.slice(prefix.length).trim() || undefined;
}

function hasDuplicatePrefix(lines: string[], prefix: string) {
  return lines.filter((line) => line.toLowerCase().startsWith(prefix.toLowerCase())).length > 1;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return parseObject(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}
