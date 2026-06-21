import "server-only";

import type { PoolClient } from "pg";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createId, nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "./project-knowledge.schema";
import { ensureProjectContextSyncSchema } from "./project-context-schema.service";

export type ContextChatbotContextEvidence = {
  sourceType: "project_context";
  sourceId: string;
  workItemId: string;
  workItemType: string;
  title: string;
  content: string;
  metadata: {
    tags?: string[];
    areaPath?: string;
    iterationPath?: string;
    updatedDate?: string;
    chunkIndex?: number;
  };
};

export type ContextChatbotKnowledgeEvidence = {
  sourceType: "project_knowledge";
  sourceId: string;
  category: string;
  entryKey: string;
  title: string;
  content: string;
  sourceWorkItemIds: string[];
  evidence: string;
};

export type ContextChatbotEvidence = {
  context: ContextChatbotContextEvidence[];
  knowledge: ContextChatbotKnowledgeEvidence[];
};

type ChunkFtsRow = {
  chunk_id: string;
  azure_work_item_id: string;
  work_item_type: string;
  title: string;
  content: string;
  metadata_json: string | null;
};

type KnowledgeFtsRow = {
  entry_id: string;
  category: string;
  entry_key: string;
  title: string;
  content: string;
  source_work_item_ids: string;
  evidence: string;
};

type KnowledgeSnapshotRow = {
  id: string;
  validated_output: string;
};

type KnowledgeEntry = {
  category: string;
  entryKey: string;
  title: string;
  content: string;
  sourceWorkItemIds: string[];
  evidence: string;
  metadata: Record<string, unknown>;
};

export async function refreshProjectContextSearchIndex(
  input: { scope: ProjectScope },
  client?: PoolClient,
) {
  const scope = assertProjectScope(input.scope);
  ensureProjectContextSyncSchema();
  const now = nowIso();
  const rows = await sqlAll<{
    id: string;
    azure_work_item_id: string | null;
    work_item_type: string | null;
    document_name: string | null;
    content: string;
    metadata_json: string | null;
  }>(
    `
      SELECT dc.id, dc.azure_work_item_id, dc.work_item_type, dc.document_name, dc.content, dc.metadata_json
      FROM document_chunks dc
      JOIN azure_devops_work_items wi
        ON wi.project_id = dc.project_id
       AND wi.azure_project_id = dc.azure_project_id
       AND wi.azure_work_item_id = dc.azure_work_item_id
      WHERE dc.project_id = @projectId
        AND dc.azure_project_id = @azureProjectId
        AND dc.source_type = 'azure_work_item'
        AND COALESCE(wi.sync_status, 'active') = 'active'
      ORDER BY dc.azure_work_item_id, dc.chunk_index
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
    client,
  );

  await sqlRun(
    `
    DELETE FROM document_chunks_fts
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
    client,
  );

  for (const row of rows) {
    await sqlRun(
      `
      INSERT INTO document_chunks_fts (
        project_id, azure_project_id, chunk_id, azure_work_item_id,
        work_item_type, title, content, metadata_json
      ) VALUES (
        @projectId, @azureProjectId, @chunkId, @azureWorkItemId,
        @workItemType, @title, @content, @metadataJson
      )
    `,
      {
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        chunkId: row.id,
        azureWorkItemId: row.azure_work_item_id ?? "",
        workItemType: row.work_item_type ?? "Unknown",
        title: row.document_name ?? "Untitled work item",
        content: row.content,
        metadataJson: row.metadata_json ?? JSON.stringify({ indexedAt: now }),
      },
      client,
    );
  }
}

export async function refreshProjectKnowledgeSearchIndex(
  input: {
    scope: ProjectScope;
    knowledgeBaseId: string;
    knowledgeBase: ProjectKnowledgeBase;
  },
  client?: PoolClient,
) {
  const scope = assertProjectScope(input.scope);
  const now = nowIso();
  const entries = flattenProjectKnowledge(input.knowledgeBase);

  await sqlRun(
    `
    DELETE FROM project_knowledge_entries_fts
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
    client,
  );

  await sqlRun(
    `
    DELETE FROM project_knowledge_entries
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
    client,
  );

  for (const entry of entries) {
    const id = createId("pke");
    const sourceWorkItemIds = entry.sourceWorkItemIds.join(", ");
    const metadataJson = JSON.stringify(entry.metadata);
    const params = {
      id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      knowledgeBaseId: input.knowledgeBaseId,
      category: entry.category,
      entryKey: entry.entryKey,
      title: entry.title,
      content: entry.content,
      sourceWorkItemIds,
      evidence: entry.evidence,
      metadataJson,
      createdAt: now,
      updatedAt: now,
    };
    await sqlRun(
      `
      INSERT INTO project_knowledge_entries (
        id, project_id, azure_project_id, azure_project_name, azure_organization_url,
        knowledge_base_id, category, entry_key, title, content, source_work_item_ids,
        evidence, metadata_json, created_at, updated_at
      ) VALUES (
        @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
        @knowledgeBaseId, @category, @entryKey, @title, @content, @sourceWorkItemIds,
        @evidence, @metadataJson, @createdAt, @updatedAt
      )
    `,
      params,
      client,
    );
    await sqlRun(
      `
      INSERT INTO project_knowledge_entries_fts (
        project_id, azure_project_id, entry_id, category, entry_key, title,
        content, source_work_item_ids, evidence, metadata_json
      ) VALUES (
        @projectId, @azureProjectId, @entryId, @category, @entryKey, @title,
        @content, @sourceWorkItemIds, @evidence, @metadataJson
      )
    `,
      {
        projectId: params.projectId,
        azureProjectId: params.azureProjectId,
        entryId: id,
        category: params.category,
        entryKey: params.entryKey,
        title: params.title,
        content: params.content,
        sourceWorkItemIds,
        evidence: params.evidence,
        metadataJson,
      },
      client,
    );
  }
}

export async function ensureContextChatbotSearchIndexes(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  ensureProjectContextSyncSchema();
  const chunkCount = await countRows(
    `
    SELECT COUNT(*)::int AS count
    FROM document_chunks dc
    JOIN azure_devops_work_items wi
      ON wi.project_id = dc.project_id
     AND wi.azure_project_id = dc.azure_project_id
     AND wi.azure_work_item_id = dc.azure_work_item_id
    WHERE dc.project_id = @projectId
      AND dc.azure_project_id = @azureProjectId
      AND dc.source_type = 'azure_work_item'
      AND COALESCE(wi.sync_status, 'active') = 'active'
  `,
    scope,
  );
  const chunkFtsCount = await countRows(
    `
    SELECT COUNT(*)::int AS count
    FROM document_chunks_fts
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
    scope,
  );
  if (chunkCount > 0 && chunkCount !== chunkFtsCount) {
    await refreshProjectContextSearchIndex({ scope });
  }

  const knowledgeSnapshot = await sqlGet<KnowledgeSnapshotRow>(
    `
      SELECT id, validated_output
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
  if (!knowledgeSnapshot) return;

  const entryCount = await countRows(
    `
    SELECT COUNT(*)::int AS count
    FROM project_knowledge_entries
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
    scope,
  );
  const entryFtsCount = await countRows(
    `
    SELECT COUNT(*)::int AS count
    FROM project_knowledge_entries_fts
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
    scope,
  );

  if (entryCount > 0 && entryCount === entryFtsCount) return;
  const knowledgeBase = ProjectKnowledgeBaseSchema.parse(JSON.parse(knowledgeSnapshot.validated_output));
  await refreshProjectKnowledgeSearchIndex({
    scope,
    knowledgeBaseId: knowledgeSnapshot.id,
    knowledgeBase,
  });
}

export async function retrieveContextChatbotEvidence(input: {
  scope: ProjectScope;
  query: string;
  contextLimit?: number;
  knowledgeLimit?: number;
}): Promise<ContextChatbotEvidence> {
  const scope = assertProjectScope(input.scope);
  await ensureContextChatbotSearchIndexes({ scope });

  const ftsQuery = buildFtsQuery(input.query);
  if (!ftsQuery) {
    return { context: [], knowledge: await getFallbackKnowledge({ scope, limit: input.knowledgeLimit ?? 8 }) };
  }

  return {
    context: await searchContext({
      scope,
      ftsQuery,
      limit: input.contextLimit ?? 10,
    }),
    knowledge: await searchKnowledge({
      scope,
      ftsQuery,
      limit: input.knowledgeLimit ?? 10,
    }),
  };
}

async function searchContext(input: { scope: ProjectScope; ftsQuery: string; limit: number }) {
  try {
    const rows = await sqlAll<ChunkFtsRow>(
      `
        SELECT chunk_id, azure_work_item_id, work_item_type, title, content, metadata_json,
               ts_rank_cd(tsv, to_tsquery('simple', @ftsQuery)) AS rank
        FROM document_chunks_fts
        WHERE tsv @@ to_tsquery('simple', @ftsQuery)
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
        ORDER BY rank DESC
        LIMIT @limit
      `,
      {
        ftsQuery: input.ftsQuery,
        projectId: input.scope.projectId,
        azureProjectId: input.scope.azureProjectId,
        limit: input.limit,
      },
    );

    return rows.map((row) => ({
      sourceType: "project_context" as const,
      sourceId: `WI:${row.azure_work_item_id}`,
      workItemId: row.azure_work_item_id,
      workItemType: row.work_item_type,
      title: row.title,
      content: row.content,
      metadata: parseChunkMetadata(row.metadata_json),
    }));
  } catch (error) {
    console.error("Project chat context FTS search failed", error);
    return [];
  }
}

async function searchKnowledge(input: { scope: ProjectScope; ftsQuery: string; limit: number }) {
  try {
    const rows = await sqlAll<KnowledgeFtsRow>(
      `
        SELECT entry_id, category, entry_key, title, content, source_work_item_ids,
               evidence, ts_rank_cd(tsv, to_tsquery('simple', @ftsQuery)) AS rank
        FROM project_knowledge_entries_fts
        WHERE tsv @@ to_tsquery('simple', @ftsQuery)
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
        ORDER BY rank DESC
        LIMIT @limit
      `,
      {
        ftsQuery: input.ftsQuery,
        projectId: input.scope.projectId,
        azureProjectId: input.scope.azureProjectId,
        limit: input.limit,
      },
    );

    const results = rows.map(toKnowledgeEvidence);
    return results.length ? results : await getFallbackKnowledge({ scope: input.scope, limit: Math.min(4, input.limit) });
  } catch (error) {
    console.error("Project chat knowledge FTS search failed", error);
    return getFallbackKnowledge({ scope: input.scope, limit: Math.min(4, input.limit) });
  }
}

async function getFallbackKnowledge(input: { scope: ProjectScope; limit: number }) {
  const rows = await sqlAll<KnowledgeFtsRow>(
    `
      SELECT id AS entry_id, category, entry_key, title, content, source_work_item_ids, evidence
      FROM project_knowledge_entries
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY category ASC, title ASC
      LIMIT @limit
    `,
    {
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      limit: input.limit,
    },
  );

  return rows.map(toKnowledgeEvidence);
}

function flattenProjectKnowledge(knowledgeBase: ProjectKnowledgeBase): KnowledgeEntry[] {
  return [
    ...knowledgeBase.modules.map((item) => ({
      category: "module",
      entryKey: item.id,
      title: item.name,
      content: [
        `Module: ${item.name}`,
        item.description,
        `Evidence: ${item.evidence}`,
        `Sources: ${item.sourceWorkItemIds.join(", ")}`,
      ].join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
    ...knowledgeBase.businessRules.map((item) => ({
      category: "business_rule",
      entryKey: item.id,
      title: item.rule,
      content: [
        `Business rule: ${item.rule}`,
        item.moduleName ? `Module: ${item.moduleName}` : "",
        `Source field: ${item.sourceField}`,
        `Evidence: ${item.evidence}`,
        `Sources: ${item.sourceWorkItemIds.join(", ")}`,
      ].filter(Boolean).join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
    ...knowledgeBase.stateTransitions.map((item) => ({
      category: "state_transition",
      entryKey: item.id,
      title: [item.workflowName, [item.fromState, item.toState].filter(Boolean).join(" -> ")]
        .filter(Boolean)
        .join(": "),
      content: [
        `Workflow: ${item.workflowName}`,
        item.fromState || item.toState ? `Transition: ${item.fromState ?? "unspecified"} -> ${item.toState ?? "unspecified"}` : "",
        `Trigger or condition: ${item.triggerOrCondition}`,
        item.actor ? `Actor: ${item.actor}` : "",
        item.moduleName ? `Module: ${item.moduleName}` : "",
        `Evidence: ${item.evidence}`,
        `Sources: ${item.sourceWorkItemIds.join(", ")}`,
      ].filter(Boolean).join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
    ...knowledgeBase.glossary.map((item) => ({
      category: "glossary",
      entryKey: item.term,
      title: item.term,
      content: [
        `Glossary term: ${item.term}`,
        `Type: ${item.type}`,
        `Definition: ${item.definition}`,
        `Evidence: ${item.evidence}`,
        `Sources: ${item.sourceWorkItemIds.join(", ")}`,
      ].join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
    ...knowledgeBase.crossDependencies.map((item) => ({
      category: "dependency",
      entryKey: item.id,
      title: `${item.sourceModule} -> ${item.targetModule}`,
      content: [
        `Dependency: ${item.sourceModule} -> ${item.targetModule}`,
        `Type: ${item.dependencyType}`,
        item.description,
        `Evidence: ${item.evidence}`,
        `Sources: ${item.sourceWorkItemIds.join(", ")}`,
      ].join("\n"),
      sourceWorkItemIds: item.sourceWorkItemIds,
      evidence: item.evidence,
      metadata: item,
    })),
  ];
}

function toKnowledgeEvidence(row: KnowledgeFtsRow): ContextChatbotKnowledgeEvidence {
  return {
    sourceType: "project_knowledge",
    sourceId: `KB:${row.category}:${row.entry_key}`,
    category: row.category,
    entryKey: row.entry_key,
    title: row.title,
    content: row.content,
    sourceWorkItemIds: splitSourceIds(row.source_work_item_ids),
    evidence: row.evidence,
  };
}

function parseChunkMetadata(value: string | null) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as ContextChatbotContextEvidence["metadata"];
    return parsed;
  } catch {
    return {};
  }
}

function splitSourceIds(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function countRows(sql: string, scope: ProjectScope) {
  const row = await sqlGet<{ count: number }>(sql, {
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
  });
  return row?.count ?? 0;
}

// Builds a PostgreSQL to_tsquery string from free text: lowercased alphanumeric
// terms (>2 chars, max 16) become prefix matches joined with OR, e.g.
// "login flow" -> "login:* | flow:*". Terms are alphanumeric-only by
// construction, so they are safe to interpolate into to_tsquery('simple', ...).
function buildFtsQuery(value: string) {
  const terms = Array.from(
    new Set(
      value
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length > 2),
    ),
  ).slice(0, 16);

  return terms.map((term) => `${term}:*`).join(" | ");
}
