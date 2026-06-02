import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createId, getDatabase, nowIso } from "@/modules/shared/infrastructure/database/db";
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

export function refreshProjectContextSearchIndex(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  ensureProjectContextSyncSchema();
  const db = getDatabase();
  const now = nowIso();
  const rows = db
    .prepare(
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
    )
    .all({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as Array<{
      id: string;
      azure_work_item_id: string | null;
      work_item_type: string | null;
      document_name: string | null;
      content: string;
      metadata_json: string | null;
    }>;

  db.prepare(
    `
    DELETE FROM document_chunks_fts
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
  ).run({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
  });

  const insert = db.prepare(
    `
    INSERT INTO document_chunks_fts (
      project_id, azure_project_id, chunk_id, azure_work_item_id,
      work_item_type, title, content, metadata_json
    ) VALUES (
      @projectId, @azureProjectId, @chunkId, @azureWorkItemId,
      @workItemType, @title, @content, @metadataJson
    )
  `,
  );

  rows.forEach((row) => {
    insert.run({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      chunkId: row.id,
      azureWorkItemId: row.azure_work_item_id ?? "",
      workItemType: row.work_item_type ?? "Unknown",
      title: row.document_name ?? "Untitled work item",
      content: row.content,
      metadataJson: row.metadata_json ?? JSON.stringify({ indexedAt: now }),
    });
  });
}

export function refreshProjectKnowledgeSearchIndex(input: {
  scope: ProjectScope;
  knowledgeBaseId: string;
  knowledgeBase: ProjectKnowledgeBase;
}) {
  const scope = assertProjectScope(input.scope);
  const db = getDatabase();
  const now = nowIso();
  const entries = flattenProjectKnowledge(input.knowledgeBase);

  db.prepare(
    `
    DELETE FROM project_knowledge_entries_fts
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
  ).run({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
  });

  db.prepare(
    `
    DELETE FROM project_knowledge_entries
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
  ).run({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
  });

  const insertEntry = db.prepare(
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
  );
  const insertFts = db.prepare(
    `
    INSERT INTO project_knowledge_entries_fts (
      project_id, azure_project_id, entry_id, category, entry_key, title,
      content, source_work_item_ids, evidence, metadata_json
    ) VALUES (
      @projectId, @azureProjectId, @entryId, @category, @entryKey, @title,
      @content, @sourceWorkItemIds, @evidence, @metadataJson
    )
  `,
  );

  entries.forEach((entry) => {
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
    insertEntry.run(params);
    insertFts.run({
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
    });
  });
}

export function ensureContextChatbotSearchIndexes(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  ensureProjectContextSyncSchema();
  const db = getDatabase();
  const chunkCount = countRows(
    `
    SELECT COUNT(*) AS count
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
  const chunkFtsCount = countRows(
    `
    SELECT COUNT(*) AS count
    FROM document_chunks_fts
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
    scope,
  );
  if (chunkCount > 0 && chunkCount !== chunkFtsCount) {
    refreshProjectContextSearchIndex({ scope });
  }

  const knowledgeSnapshot = db
    .prepare(
      `
      SELECT id, validated_output
      FROM project_knowledge_base
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      LIMIT 1
    `,
    )
    .get({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as KnowledgeSnapshotRow | undefined;
  if (!knowledgeSnapshot) return;

  const entryCount = countRows(
    `
    SELECT COUNT(*) AS count
    FROM project_knowledge_entries
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
    scope,
  );
  const entryFtsCount = countRows(
    `
    SELECT COUNT(*) AS count
    FROM project_knowledge_entries_fts
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `,
    scope,
  );

  if (entryCount > 0 && entryCount === entryFtsCount) return;
  const knowledgeBase = ProjectKnowledgeBaseSchema.parse(JSON.parse(knowledgeSnapshot.validated_output));
  refreshProjectKnowledgeSearchIndex({
    scope,
    knowledgeBaseId: knowledgeSnapshot.id,
    knowledgeBase,
  });
}

export function retrieveContextChatbotEvidence(input: {
  scope: ProjectScope;
  query: string;
  contextLimit?: number;
  knowledgeLimit?: number;
}): ContextChatbotEvidence {
  const scope = assertProjectScope(input.scope);
  ensureContextChatbotSearchIndexes({ scope });

  const ftsQuery = buildFtsQuery(input.query);
  if (!ftsQuery) {
    return { context: [], knowledge: getFallbackKnowledge({ scope, limit: input.knowledgeLimit ?? 8 }) };
  }

  return {
    context: searchContext({
      scope,
      ftsQuery,
      limit: input.contextLimit ?? 10,
    }),
    knowledge: searchKnowledge({
      scope,
      ftsQuery,
      limit: input.knowledgeLimit ?? 10,
    }),
  };
}

function searchContext(input: { scope: ProjectScope; ftsQuery: string; limit: number }) {
  const db = getDatabase();
  try {
    const rows = db
      .prepare(
        `
        SELECT chunk_id, azure_work_item_id, work_item_type, title, content, metadata_json,
               bm25(document_chunks_fts) AS rank
        FROM document_chunks_fts
        WHERE document_chunks_fts MATCH @ftsQuery
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
        ORDER BY rank
        LIMIT @limit
      `,
      )
      .all({
        ftsQuery: input.ftsQuery,
        projectId: input.scope.projectId,
        azureProjectId: input.scope.azureProjectId,
        limit: input.limit,
      }) as ChunkFtsRow[];

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

function searchKnowledge(input: { scope: ProjectScope; ftsQuery: string; limit: number }) {
  const db = getDatabase();
  try {
    const rows = db
      .prepare(
        `
        SELECT entry_id, category, entry_key, title, content, source_work_item_ids,
               evidence, bm25(project_knowledge_entries_fts) AS rank
        FROM project_knowledge_entries_fts
        WHERE project_knowledge_entries_fts MATCH @ftsQuery
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
        ORDER BY rank
        LIMIT @limit
      `,
      )
      .all({
        ftsQuery: input.ftsQuery,
        projectId: input.scope.projectId,
        azureProjectId: input.scope.azureProjectId,
        limit: input.limit,
      }) as KnowledgeFtsRow[];

    const results = rows.map(toKnowledgeEvidence);
    return results.length ? results : getFallbackKnowledge({ scope: input.scope, limit: Math.min(4, input.limit) });
  } catch (error) {
    console.error("Project chat knowledge FTS search failed", error);
    return getFallbackKnowledge({ scope: input.scope, limit: Math.min(4, input.limit) });
  }
}

function getFallbackKnowledge(input: { scope: ProjectScope; limit: number }) {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
      SELECT id AS entry_id, category, entry_key, title, content, source_work_item_ids, evidence
      FROM project_knowledge_entries
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY category ASC, title ASC
      LIMIT @limit
    `,
    )
    .all({
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      limit: input.limit,
    }) as KnowledgeFtsRow[];

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

function countRows(sql: string, scope: ProjectScope) {
  const row = getDatabase()
    .prepare(sql)
    .get({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as { count: number };
  return row.count;
}

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

  return terms.map((term) => `${term}*`).join(" OR ");
}
