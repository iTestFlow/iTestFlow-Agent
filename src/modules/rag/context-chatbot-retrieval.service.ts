import "server-only";

import type { PoolClient } from "pg";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createId, nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  ProjectKnowledgeBaseSchema,
  renderProjectKnowledgeEvidenceRefs,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeEvidenceRef,
} from "./project-knowledge.schema";
import { canonicalizeProjectKnowledgeKey, getEntryProvenanceStatus } from "./project-knowledge-contracts";
import { ensureProjectContextSyncSchema } from "./project-context-schema.service";
import { buildFtsQueryWithDynamicSynonyms } from "./full-text-search";
import {
  buildRetrievalQueryWithHistory,
  type ContextChatbotHistoryMessage,
} from "@/modules/context-chatbot/context-chatbot-history";
import { searchProjectKnowledgeByTrigram } from "./trigram-search";
import { fuseByReciprocalRank } from "./hybrid-ranking";
import { searchProjectChunksHybrid } from "./hybrid-chunk-search";
import type { MetadataFilter } from "./metadata-filter";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
import type { RerankProvider } from "./rerank-provider";
import { searchProjectKnowledgeByEmbedding } from "./embedding-store.service";
import {
  normalizeProjectContextSourceKinds,
  type ProjectContextSourceKind,
} from "./project-context-source";

type ContextChatbotContextMetadata = {
  tags?: string[];
  areaPath?: string;
  iterationPath?: string;
  updatedDate?: string;
  chunkIndex?: number;
  section?: string;
  pageNumber?: number;
};

export type ContextChatbotWorkItemEvidence = {
  sourceType: "project_context";
  sourceId: string;
  workItemId: string;
  workItemType: string;
  title: string;
  content: string;
  metadata: ContextChatbotContextMetadata;
};

export type ContextChatbotDocumentEvidence = {
  sourceType: "uploaded_document";
  sourceId: string;
  /** Legacy-compatible placeholder; consumers must branch on sourceType/sourceId. */
  workItemId: "";
  workItemType: "Document";
  documentId: string;
  documentVersionId: string;
  documentName: string;
  title: string;
  content: string;
  metadata: ContextChatbotContextMetadata;
};

export type ContextChatbotContextEvidence = ContextChatbotWorkItemEvidence | ContextChatbotDocumentEvidence;

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
  retrievalMode?: "raw_wins" | "trusted_compiled";
};

type ChunkFtsRow = {
  chunk_id: string;
  source_type: ProjectContextSourceKind;
  azure_work_item_id: string | null;
  work_item_type: string | null;
  document_id: string | null;
  source_document_version_id: string | null;
  title: string;
  section: string | null;
  page_number: number | null;
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
  evidenceRefs: ProjectKnowledgeEvidenceRef[];
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
    source_type: ProjectContextSourceKind;
    azure_work_item_id: string | null;
    work_item_type: string | null;
    document_id: string | null;
    source_document_version_id: string | null;
    document_name: string | null;
    section: string | null;
    page_number: number | null;
    content: string;
    metadata_json: string | null;
  }>(
    `
      SELECT dc.id, dc.source_type, dc.azure_work_item_id, dc.work_item_type, dc.document_id,
             dc.source_document_version_id, dc.document_name, dc.section, dc.page_number,
             dc.content, dc.metadata_json
      FROM document_chunks dc
      WHERE dc.project_id = @projectId
        AND dc.azure_project_id = @azureProjectId
        AND (
          (
            dc.source_type = 'azure_work_item'
            AND EXISTS (
              SELECT 1
              FROM azure_devops_work_items wi
              WHERE wi.project_id = dc.project_id
                AND wi.azure_project_id = dc.azure_project_id
                AND wi.azure_work_item_id = dc.azure_work_item_id
                AND COALESCE(wi.sync_status, 'active') = 'active'
            )
          )
          OR (
            dc.source_type = 'uploaded_document'
            AND EXISTS (
              SELECT 1
              FROM project_source_documents psd
              WHERE psd.id = dc.document_id
                AND psd.project_id = dc.project_id
                AND psd.azure_project_id = dc.azure_project_id
                AND psd.lifecycle_status = 'active'
                AND psd.current_version_id = dc.source_document_version_id
            )
          )
        )
      ORDER BY dc.source_type, COALESCE(dc.azure_work_item_id, dc.document_id), dc.chunk_index
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
        project_id, azure_project_id, chunk_id, source_type, azure_work_item_id,
        work_item_type, document_id, source_document_version_id, title, section,
        page_number, content, metadata_json
      ) VALUES (
        @projectId, @azureProjectId, @chunkId, @sourceType, @azureWorkItemId,
        @workItemType, @documentId, @sourceDocumentVersionId, @title, @section,
        @pageNumber, @content, @metadataJson
      )
    `,
      {
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        chunkId: row.id,
        sourceType: row.source_type,
        azureWorkItemId: row.azure_work_item_id ?? "",
        workItemType: row.work_item_type ?? "Unknown",
        documentId: row.document_id,
        sourceDocumentVersionId: row.source_document_version_id,
        title: row.document_name ?? "Untitled work item",
        section: row.section,
        pageNumber: row.page_number,
        content: row.content,
        metadataJson: row.metadata_json ?? JSON.stringify({ indexedAt: now }),
      },
      client,
    );
  }
}

/**
 * Category for knowledge an admin approved from a chatbot answer, as opposed to
 * knowledge the compiler extracted from work items.
 *
 * Kept as its own category for two reasons. It must survive a knowledge republish,
 * which wipes and rebuilds every compiled entry — an approved insight is not derived
 * from the compiled base and would otherwise vanish the next time anyone publishes a
 * draft. And it must stay distinguishable in citations: a compiled entry is
 * re-anchorable to immutable snapshot quotes, while this is a model synthesis a human
 * accepted. Both are useful; conflating them would quietly weaken what "verified"
 * means everywhere it is asserted.
 */
export const CHAT_INSIGHT_CATEGORY = "chat_insight";

/**
 * Makes an approved chatbot answer searchable, by writing it into the same two tables
 * compiled knowledge lives in. Every knowledge retrieval signal — full text, trigram,
 * and (once embeddings sync) semantic — then finds it with no additional plumbing,
 * because they all read these tables.
 *
 * Idempotent per candidate: re-approving replaces the entry rather than adding a second
 * copy.
 */
export async function indexApprovedChatInsight(
  input: {
    scope: ProjectScope;
    candidateId: string;
    /**
     * Identity of the insight itself, derived from its content by the caller. Keyed on
     * content rather than on the candidate so the same answer approved twice — from two
     * separate saves — collapses to one entry instead of stacking duplicates in every
     * later prompt.
     */
    entryKey: string;
    title: string;
    content: string;
    sourceWorkItemIds: string[];
    evidence: string;
  },
  client?: PoolClient,
) {
  const scope = assertProjectScope(input.scope);
  await ensureProjectContextSyncSchema();
  const now = nowIso();
  const entryKey = input.entryKey;
  const sourceWorkItemIds = input.sourceWorkItemIds.join(", ");
  const metadataJson = JSON.stringify({ candidateId: input.candidateId, origin: "chatbot_answer" });

  for (const table of ["project_knowledge_entries_fts", "project_knowledge_entries"] as const) {
    await sqlRun(
      `
        DELETE FROM ${table}
        WHERE project_id = @projectId
          AND azure_project_id = @azureProjectId
          AND category = @category
          AND entry_key = @entryKey
      `,
      {
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        category: CHAT_INSIGHT_CATEGORY,
        entryKey,
      },
      client,
    );
  }

  const id = createId("pke");
  await sqlRun(
    `
      INSERT INTO project_knowledge_entries (
        id, project_id, azure_project_id, azure_project_name, azure_organization_url,
        knowledge_base_id, category, entry_key, title, content, source_work_item_ids,
        evidence, metadata_json, created_at, updated_at, provenance_status
      ) VALUES (
        @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
        @knowledgeBaseId, @category, @entryKey, @title, @content, @sourceWorkItemIds,
        @evidence, @metadataJson, @createdAt, @updatedAt, @provenanceStatus
      )
    `,
    {
      id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      // Traceable back to the candidate it came from rather than to a compiled base,
      // because it did not come from one.
      knowledgeBaseId: input.candidateId,
      category: CHAT_INSIGHT_CATEGORY,
      entryKey,
      title: input.title,
      content: input.content,
      sourceWorkItemIds,
      evidence: input.evidence,
      metadataJson,
      createdAt: now,
      updatedAt: now,
      // Never "verified": a synthesis across several work items is not a quote from any
      // one of them, which is exactly why the candidate was held ungrounded.
      provenanceStatus: "human_approved",
    },
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
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      entryId: id,
      category: CHAT_INSIGHT_CATEGORY,
      entryKey,
      title: input.title,
      content: input.content,
      sourceWorkItemIds,
      evidence: input.evidence,
      metadataJson,
    },
    client,
  );
  return { entryId: id };
}

/**
 * Removes an approved insight from the search index, so rejecting it actually stops it
 * being answerable.
 *
 * Entries are keyed by content, which means two candidates carrying the same answer share
 * one entry. The caller must therefore only invoke this once no *other* integrated
 * candidate still claims that content — otherwise rejecting one duplicate would silently
 * un-publish another admin's still-approved insight.
 */
export async function removeChatInsightFromSearchIndex(
  input: { scope: ProjectScope; entryKey: string },
  client?: PoolClient,
) {
  const scope = assertProjectScope(input.scope);
  let removed = 0;
  for (const table of ["project_knowledge_entries_fts", "project_knowledge_entries"] as const) {
    removed = await sqlRun(
      `
        DELETE FROM ${table}
        WHERE project_id = @projectId
          AND azure_project_id = @azureProjectId
          AND category = @category
          AND entry_key = @entryKey
      `,
      {
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        category: CHAT_INSIGHT_CATEGORY,
        entryKey: input.entryKey,
      },
      client,
    );
  }
  return { removed };
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
  const activeVersions = await sqlAll<{
    id: string;
    category: string;
    entry_key: string;
    entry_semantic_hash: string | null;
    entry_provenance_hash: string | null;
  }>(
    `
      SELECT id, category, entry_key, entry_semantic_hash, entry_provenance_hash
      FROM project_knowledge_entry_versions
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND status = 'active'
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
    client,
  );
  const activeVersionByKey = new Map(
    activeVersions.map((version) => [
      `${version.category}:${canonicalizeProjectKnowledgeKey(version.entry_key)}`,
      version,
    ]),
  );

  // Compiled entries are rebuilt wholesale from the base, but admin-approved chat
  // insights are not in that base and must survive the rebuild — without this guard,
  // publishing any knowledge draft silently discards every approved insight.
  await sqlRun(
    `
    DELETE FROM project_knowledge_entries_fts
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
      AND category <> @chatInsightCategory
  `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      chatInsightCategory: CHAT_INSIGHT_CATEGORY,
    },
    client,
  );

  await sqlRun(
    `
    DELETE FROM project_knowledge_entries
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
      AND category <> @chatInsightCategory
  `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      chatInsightCategory: CHAT_INSIGHT_CATEGORY,
    },
    client,
  );

  for (const entry of entries) {
    const id = createId("pke");
    const sourceWorkItemIds = entry.sourceWorkItemIds.join(", ");
    const metadataJson = JSON.stringify(entry.metadata);
    const activeVersion = activeVersionByKey.get(
      `${entry.category}:${canonicalizeProjectKnowledgeKey(entry.entryKey)}`,
    );
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
      entryVersionId: activeVersion?.id ?? null,
      entrySemanticHash: activeVersion?.entry_semantic_hash ?? null,
      entryProvenanceHash: activeVersion?.entry_provenance_hash ?? null,
      provenanceStatus: getEntryProvenanceStatus(entry.evidenceRefs),
      createdAt: now,
      updatedAt: now,
    };
    await sqlRun(
      `
      INSERT INTO project_knowledge_entries (
        id, project_id, azure_project_id, azure_project_name, azure_organization_url,
        knowledge_base_id, category, entry_key, title, content, source_work_item_ids,
        evidence, metadata_json, created_at, updated_at, entry_version_id,
        entry_semantic_hash, entry_provenance_hash, provenance_status
      ) VALUES (
        @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
        @knowledgeBaseId, @category, @entryKey, @title, @content, @sourceWorkItemIds,
        @evidence, @metadataJson, @createdAt, @updatedAt, @entryVersionId,
        @entrySemanticHash, @entryProvenanceHash, @provenanceStatus
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

/**
 * Self-heals the chunk FTS table when it drifts from the active chunk set (e.g. a
 * database restored from before the FTS table was populated). Cheap when consistent:
 * two COUNT queries against indexed columns.
 */
export async function ensureProjectContextSearchIndex(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  ensureProjectContextSyncSchema();
  const chunkCount = await countRows(
    `
    SELECT COUNT(*)::int AS count
    FROM document_chunks dc
    WHERE dc.project_id = @projectId
      AND dc.azure_project_id = @azureProjectId
      AND (
        (
          dc.source_type = 'azure_work_item'
          AND EXISTS (
            SELECT 1 FROM azure_devops_work_items wi
            WHERE wi.project_id = dc.project_id
              AND wi.azure_project_id = dc.azure_project_id
              AND wi.azure_work_item_id = dc.azure_work_item_id
              AND COALESCE(wi.sync_status, 'active') = 'active'
          )
        )
        OR (
          dc.source_type = 'uploaded_document'
          AND EXISTS (
            SELECT 1 FROM project_source_documents psd
            WHERE psd.id = dc.document_id
              AND psd.project_id = dc.project_id
              AND psd.azure_project_id = dc.azure_project_id
              AND psd.lifecycle_status = 'active'
              AND psd.current_version_id = dc.source_document_version_id
          )
        )
      )
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
  if (chunkCount !== chunkFtsCount) {
    await refreshProjectContextSearchIndex({ scope });
  }
}

export async function ensureContextChatbotSearchIndexes(input: { scope: ProjectScope }) {
  const scope = assertProjectScope(input.scope);
  await ensureProjectContextSearchIndex({ scope });

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
  maxContextChunksPerWorkItem?: number;
  selectedWorkItemIds?: string[];
  /**
   * Recent conversation, used ONLY to give a follow-up question enough meaning to
   * retrieve on. Lexical search still uses the literal question.
   */
  history?: ContextChatbotHistoryMessage[];
  /**
   * Seam for tests: undefined uses the built-in local model, null skips semantic
   * search entirely so a test never loads the ~131 MB ONNX weights.
   */
  embeddingProvider?: EmbeddingProvider | null;
  /**
   * Seam for tests: undefined uses the built-in local cross-encoder, null skips
   * reranking entirely so a test never loads the model weights.
   */
  rerankProvider?: RerankProvider | null;
  /** Defaults to both indexed work-item and uploaded-document evidence. */
  sourceKinds?: readonly ProjectContextSourceKind[];
  /** Opt-in restriction by work item type / area path / iteration path. Never state. */
  filter?: MetadataFilter;
}): Promise<ContextChatbotEvidence> {
  const scope = assertProjectScope(input.scope);
  await ensureContextChatbotSearchIndexes({ scope });
  const contextLimit = input.contextLimit ?? 10;
  const knowledgeLimit = input.knowledgeLimit ?? 10;
  const maxContextChunksPerWorkItem = input.maxContextChunksPerWorkItem ?? 2;
  const sourceKinds = normalizeProjectContextSourceKinds(input.sourceKinds);

  // Resolved once and threaded into every consumer below, so a caller (tests) can
  // disable semantic search for the whole evidence pass with a single seam.
  const embeddingProvider = input.embeddingProvider !== undefined ? input.embeddingProvider : createEmbeddingProvider();
  // Lexical search matches the literal question; semantic search gets the follow-up
  // resolved against recent turns. See buildRetrievalQueryWithHistory for why they differ.
  const semanticQuery = buildRetrievalQueryWithHistory(input.query, input.history);
  const ftsQuery = await buildFtsQueryWithDynamicSynonyms(input.query, embeddingProvider);
  const selectedWorkItemIds = Array.from(new Set(input.selectedWorkItemIds ?? []));
  if (!ftsQuery) {
    const selected = selectedWorkItemIds.length
      ? await loadSelectedContext({
          scope,
          selectedWorkItemIds,
          limit: contextLimit,
          maxChunksPerWorkItem: maxContextChunksPerWorkItem,
        })
      : [];
    return { context: selected, knowledge: await getFallbackKnowledge({ scope, limit: knowledgeLimit }) };
  }

  const knowledge = await searchKnowledge({ scope, ftsQuery, rawQuery: input.query, semanticQuery, limit: knowledgeLimit, embeddingProvider });
  const trustedCompiled = knowledge.length > 0 && await hasTrustedCompiledKnowledge(scope);
  const selected = selectedWorkItemIds.length
    ? await loadSelectedContext({
        scope,
        selectedWorkItemIds,
        limit: contextLimit,
        maxChunksPerWorkItem: maxContextChunksPerWorkItem,
      })
    : [];
  const searched = await searchContext({
    scope,
    ftsQuery,
    rawQuery: input.query,
    semanticQuery,
    limit: contextLimit,
    maxChunksPerWorkItem: maxContextChunksPerWorkItem,
    embeddingProvider,
    rerankProvider: input.rerankProvider,
    filter: input.filter,
    sourceKinds,
  });
  const context = mergeContextEvidence(selected, searched, contextLimit, maxContextChunksPerWorkItem);
  return {
    context,
    knowledge,
    ...(trustedCompiled ? { retrievalMode: "trusted_compiled" as const } : {}),
  };
}

function mergeContextEvidence(
  selected: ContextChatbotContextEvidence[],
  searched: ContextChatbotContextEvidence[],
  limit: number,
  maxChunksPerWorkItem: number,
) {
  const seen = new Set<string>();
  const merged = [...selected, ...searched].filter((item) => {
    const key = `${item.sourceId}\u0000${item.content}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return limitContextEvidenceBySource(merged, { limit, maxChunksPerSource: maxChunksPerWorkItem });
}

async function loadSelectedContext(input: {
  scope: ProjectScope;
  selectedWorkItemIds: string[];
  limit: number;
  maxChunksPerWorkItem: number;
}) {
  const rows = await sqlAll<ChunkFtsRow>(
    `
       SELECT chunks.id AS chunk_id, chunks.source_type, chunks.azure_work_item_id, chunks.work_item_type,
              chunks.document_id, chunks.source_document_version_id, chunks.document_name AS title,
              chunks.section, chunks.page_number, chunks.content, chunks.metadata_json
      FROM document_chunks chunks
      JOIN azure_devops_work_items work_items
        ON work_items.project_id = chunks.project_id
       AND work_items.azure_project_id = chunks.azure_project_id
       AND work_items.azure_work_item_id = chunks.azure_work_item_id
      WHERE chunks.project_id = @projectId AND chunks.azure_project_id = @azureProjectId
        AND chunks.source_type = 'azure_work_item'
        AND chunks.azure_work_item_id = ANY(@selectedWorkItemIds::text[])
        AND COALESCE(work_items.sync_status, 'active') = 'active'
      ORDER BY array_position(@selectedWorkItemIds::text[], chunks.azure_work_item_id), chunks.chunk_index
      LIMIT @rowLimit
    `,
    {
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      selectedWorkItemIds: input.selectedWorkItemIds,
      rowLimit: input.limit * input.maxChunksPerWorkItem,
    },
  );
  return limitContextEvidenceBySource(rows.map((row) => ({
    sourceType: "project_context" as const,
    sourceId: `WI:${row.azure_work_item_id}`,
    workItemId: row.azure_work_item_id ?? "",
    workItemType: row.work_item_type ?? "Unknown",
    title: row.title ?? "Untitled work item",
    content: row.content,
    metadata: parseChunkMetadata(row.metadata_json),
  })), {
    limit: input.limit,
    maxChunksPerSource: input.maxChunksPerWorkItem,
  });
}

async function hasTrustedCompiledKnowledge(scope: ProjectScope) {
  const row = await sqlGet<{
    freshness_status: string;
    provenance_status: string;
    compiler_compatibility: string;
  }>(
    `
      SELECT freshness_status, provenance_status, compiler_compatibility
      FROM project_knowledge_base
      WHERE project_id = @projectId AND azure_project_id = @azureProjectId
      LIMIT 1
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
  );
  return Boolean(
    row &&
    row.freshness_status === "current" &&
    row.provenance_status === "verified" &&
    row.compiler_compatibility === "current",
  );
}

async function searchContext(input: {
  scope: ProjectScope;
  ftsQuery: string;
  rawQuery: string;
  semanticQuery?: string;
  limit: number;
  maxChunksPerWorkItem?: number;
  embeddingProvider?: EmbeddingProvider | null;
  rerankProvider?: RerankProvider | null;
  sourceKinds?: readonly ProjectContextSourceKind[];
  /** Opt-in restriction by work item type / area path / iteration path. Never state. */
  filter?: MetadataFilter;
}) {
  const maxChunksPerWorkItem = positiveIntegerOrDefault(input.maxChunksPerWorkItem, input.limit);
  // searchProjectChunksHybrid never throws (every source is independently caught
  // inside it) and already enforces the per-work-item cap on its fused output, so
  // no outer try/catch or second cap pass is needed here.
  const fused = await searchProjectChunksHybrid({
    scope: input.scope,
    ftsQuery: input.ftsQuery,
    rawQuery: input.rawQuery,
    semanticQuery: input.semanticQuery,
    topK: input.limit,
    maxChunksPerWorkItem,
    embeddingProvider: input.embeddingProvider,
    rerankProvider: input.rerankProvider,
    filter: input.filter,
    sourceKinds: input.sourceKinds,
  });
  return fused.map(({ row }) => toContextEvidence(row));
}

function toContextEvidence(row: {
  source_type: ProjectContextSourceKind;
  azure_work_item_id: string | null;
  work_item_type: string | null;
  document_id: string | null;
  source_document_version_id: string | null;
  document_name: string | null;
  section: string | null;
  page_number: number | null;
  content: string;
  metadata_json: string | null;
}): ContextChatbotContextEvidence {
  const metadata = parseChunkMetadata(row.metadata_json);
  if (row.source_type === "uploaded_document") {
    const documentId = row.document_id ?? "unknown-document";
    const documentVersionId = row.source_document_version_id ?? "unknown-version";
    return {
      sourceType: "uploaded_document",
      sourceId: `DOC:${documentId}`,
      workItemId: "",
      workItemType: "Document",
      documentId,
      documentVersionId,
      documentName: row.document_name ?? "Untitled document",
      title: row.document_name ?? "Untitled document",
      content: row.content,
      metadata: {
        ...metadata,
        section: row.section ?? metadata.section,
        pageNumber: row.page_number ?? metadata.pageNumber,
      },
    };
  }
  return {
    sourceType: "project_context",
    sourceId: `WI:${row.azure_work_item_id ?? ""}`,
    workItemId: row.azure_work_item_id ?? "",
    workItemType: row.work_item_type ?? "Unknown",
    title: row.document_name ?? "Untitled work item",
    content: row.content,
    metadata,
  };
}

export function limitContextEvidenceBySource<TItem extends { sourceId: string }>(
  items: TItem[],
  input: { limit: number; maxChunksPerSource?: number },
): TItem[] {
  const limit = positiveIntegerOrDefault(input.limit, items.length);
  const maxChunksPerSource = positiveIntegerOrDefault(input.maxChunksPerSource, limit);
  const countsBySource = new Map<string, number>();
  const selected: TItem[] = [];

  for (const item of items) {
    if (selected.length >= limit) break;
    const key = item.sourceId || "__missing_source_id__";
    const count = countsBySource.get(key) ?? 0;
    if (count >= maxChunksPerSource) continue;
    countsBySource.set(key, count + 1);
    selected.push(item);
  }

  return selected;
}

/** Legacy-compatible work-item helper retained for existing callers/tests. */
export function limitContextEvidenceByWorkItem<TItem extends { workItemId: string }>(
  items: TItem[],
  input: { limit: number; maxChunksPerWorkItem?: number },
): TItem[] {
  return limitContextEvidenceBySource(
    items.map((item) => ({ ...item, sourceId: `WI:${item.workItemId}` })),
    { limit: input.limit, maxChunksPerSource: input.maxChunksPerWorkItem },
  ).map((item) => {
    const legacyItem = { ...item } as Record<string, unknown>;
    delete legacyItem.sourceId;
    return legacyItem as unknown as TItem;
  });
}

async function searchKnowledge(input: {
  scope: ProjectScope;
  ftsQuery: string;
  rawQuery: string;
  semanticQuery?: string;
  limit: number;
  embeddingProvider?: EmbeddingProvider | null;
}) {
  let ftsRows: KnowledgeFtsRow[] = [];
  try {
    ftsRows = await sqlAll<KnowledgeFtsRow>(
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
  } catch (error) {
    console.error("Project chat knowledge FTS search failed", error);
  }

  let trigramRows: KnowledgeFtsRow[] = [];
  try {
    trigramRows = await searchProjectKnowledgeByTrigram({
      scope: input.scope,
      query: input.rawQuery,
      topK: input.limit,
    });
  } catch (error) {
    console.error("Project chat knowledge trigram search failed", error);
  }

  const embeddingProvider =
    input.embeddingProvider !== undefined ? input.embeddingProvider : createEmbeddingProvider();
  let semanticRows: KnowledgeFtsRow[] = [];
  if (embeddingProvider) {
    try {
      semanticRows = await searchProjectKnowledgeByEmbedding({
        scope: input.scope,
        provider: embeddingProvider,
        query: input.semanticQuery ?? input.rawQuery,
        topK: input.limit,
      });
    } catch (error) {
      console.error("Project chat knowledge semantic search failed", error);
    }
  }

  // No trigram or semantic signal: keep FTS's own ts_rank_cd order rather than
  // running a single-list fusion through RRF, which would flatten its real score
  // spread.
  if (!trigramRows.length && !semanticRows.length) {
    const results = ftsRows.map(toKnowledgeEvidence);
    return results.length ? results : getFallbackKnowledge({ scope: input.scope, limit: Math.min(4, input.limit) });
  }

  const fused = fuseByReciprocalRank({
    lists: [ftsRows, trigramRows, semanticRows].filter((list) => list.length > 0),
    getKey: (row) => row.entry_id,
  });
  if (!fused.length) return getFallbackKnowledge({ scope: input.scope, limit: Math.min(4, input.limit) });
  return fused.slice(0, input.limit).map(({ item }) => toKnowledgeEvidence(item));
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
  const provenance = (item: {
    sourceWorkItemIds: string[];
    evidence: string;
    evidenceRefs?: ProjectKnowledgeEvidenceRef[];
  }) => {
    const evidenceRefs = item.evidenceRefs ?? [];
    return {
      sourceWorkItemIds: evidenceRefs.length
        ? Array.from(new Set(evidenceRefs.flatMap((ref) =>
          ref.sourceKind === "document" || !ref.sourceWorkItemId ? [] : [ref.sourceWorkItemId])))
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
      content: [
        `Module: ${item.name}`,
        item.description,
      ].join("\n"),
      ...provenance(item),
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
      ].filter(Boolean).join("\n"),
      ...provenance(item),
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
      ].filter(Boolean).join("\n"),
      ...provenance(item),
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
      ].join("\n"),
      ...provenance(item),
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
      ].join("\n"),
      ...provenance(item),
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

function positiveIntegerOrDefault(value: number | undefined, fallback: number) {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback;
}

async function countRows(sql: string, scope: ProjectScope) {
  const row = await sqlGet<{ count: number }>(sql, {
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
  });
  return row?.count ?? 0;
}
