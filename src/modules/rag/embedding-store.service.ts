import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createId, nowIso, sqlAll, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { MAX_EMBED_BATCH_SIZE, type EmbeddingProvider } from "./embedding-provider";
import { cosineSimilarity } from "./hybrid-ranking";

/**
 * Persists chunk embeddings in the `embeddings` table (vector_json holds the raw
 * vector; vector_reference records provider:model so a backend change re-embeds).
 * Similarity search loads the active project's vectors and ranks in process —
 * project corpora are small (hundreds to low thousands of chunks), so an O(n) scan
 * per query needs no vector-index extension. The store is an implementation detail
 * behind retrieveStoredProjectContext's hybrid retrieval; failures there degrade to
 * full-text search.
 */

export type SemanticContextChunk = {
  id: string;
  azure_work_item_id: string | null;
  work_item_type: string | null;
  document_name: string | null;
  content: string;
  metadata_json: string | null;
  similarity: number;
};

export type SemanticKnowledgeEntry = {
  entry_id: string;
  category: string;
  entry_key: string;
  title: string;
  content: string;
  source_work_item_ids: string;
  evidence: string;
  similarity: number;
};

// Discriminates the two embedding pipelines sharing the `embeddings` table so
// neither's orphan-cleanup or search queries can see the other's rows. Raw
// work-item chunks are keyed by document_chunks.id; knowledge entries have no
// stable per-save id (see knowledgeEmbeddingChunkId), so they get a distinct
// synthetic chunk_id namespace under their own source_type.
const CHUNK_SOURCE_TYPE = "azure_work_item_chunk";
const KNOWLEDGE_SOURCE_TYPE = "project_knowledge_entry";

const ACTIVE_CHUNK_FILTER_SQL = `
  dc.project_id = @projectId
  AND dc.azure_project_id = @azureProjectId
  AND dc.source_type = 'azure_work_item'
  AND EXISTS (
    SELECT 1
    FROM azure_devops_work_items wi
    WHERE wi.project_id = dc.project_id
      AND wi.azure_project_id = dc.azure_project_id
      AND wi.azure_work_item_id = dc.azure_work_item_id
      AND COALESCE(wi.sync_status, 'active') = 'active'
  )
`;

/**
 * Brings stored vectors in line with the current chunk set: removes embeddings whose
 * chunk no longer exists, then embeds active chunks that lack a vector for the
 * provider's current vector reference (covers new chunks, changed chunks — re-chunked
 * rows get new deletes/inserts upstream — and provider/model switches).
 */
export async function syncProjectChunkEmbeddings(input: {
  scope: ProjectScope;
  provider: EmbeddingProvider;
}) {
  const scope = assertProjectScope(input.scope);
  const removedCount = await sqlRun(
    `
      DELETE FROM embeddings
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND source_type = @sourceType
        AND NOT EXISTS (
          SELECT 1 FROM document_chunks dc WHERE dc.id = embeddings.chunk_id
        )
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceType: CHUNK_SOURCE_TYPE,
    },
  );

  // A chunk is pending when it has no embedding at the current vector_reference, OR
  // its embedding predates the chunk's own last content change (document_chunks.id is
  // deterministic and reused across a content edit that doesn't change the chunk
  // count, so existence alone isn't enough — the stale vector would otherwise be
  // reused forever). document_chunks.updated_at only advances on a real content
  // change (unchanged content takes an early-continue in the indexing loop that never
  // touches the row), so this comparison is safe.
  const pending = await sqlAll<{ id: string; content: string }>(
    `
      SELECT dc.id, dc.content
      FROM document_chunks dc
      LEFT JOIN embeddings e
        ON e.chunk_id = dc.id
       AND e.source_type = @sourceType
       AND e.vector_reference = @vectorReference
      WHERE ${ACTIVE_CHUNK_FILTER_SQL}
        AND (e.id IS NULL OR e.updated_at < dc.updated_at)
      ORDER BY dc.id
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceType: CHUNK_SOURCE_TYPE,
      vectorReference: input.provider.vectorReference,
    },
  );

  // Embed and persist one batch at a time instead of embedding the whole pending list
  // and inserting only after everything succeeds: if a later batch fails, every batch
  // before it is already durably saved and won't be redone (or lost) on the next sync.
  let embeddedChunkCount = 0;
  for (let start = 0; start < pending.length; start += MAX_EMBED_BATCH_SIZE) {
    const batch = pending.slice(start, start + MAX_EMBED_BATCH_SIZE);
    const vectors = await input.provider.embed(batch.map((chunk) => chunk.content), "document");
    const now = nowIso();
    for (const [index, chunk] of batch.entries()) {
      await sqlRun(
        `
          INSERT INTO embeddings (
            id, project_id, azure_project_id, chunk_id, source_type, provider, model,
            vector_reference, vector_json, created_at, updated_at
          ) VALUES (
            @id, @projectId, @azureProjectId, @chunkId, @sourceType, @provider, @model,
            @vectorReference, @vectorJson, @createdAt, @updatedAt
          )
          ON CONFLICT (source_type, chunk_id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            vector_reference = excluded.vector_reference,
            vector_json = excluded.vector_json,
            updated_at = excluded.updated_at
        `,
        {
          id: createId("emb"),
          projectId: scope.projectId,
          azureProjectId: scope.azureProjectId,
          chunkId: chunk.id,
          sourceType: CHUNK_SOURCE_TYPE,
          provider: input.provider.name,
          model: input.provider.model,
          vectorReference: input.provider.vectorReference,
          vectorJson: JSON.stringify(vectors[index]),
          createdAt: now,
          updatedAt: now,
        },
      );
      embeddedChunkCount += 1;
    }
  }

  return {
    embeddedChunkCount,
    removedEmbeddingCount: removedCount,
  };
}

/**
 * Embeds the query and ranks the project's active, current-reference vectors by
 * cosine similarity, capping chunks per work item so one verbose item cannot fill
 * the result.
 */
export async function searchProjectContextByEmbedding(input: {
  scope: ProjectScope;
  provider: EmbeddingProvider;
  query: string;
  topK: number;
  maxChunksPerWorkItem?: number;
}): Promise<SemanticContextChunk[]> {
  const scope = assertProjectScope(input.scope);
  const query = input.query.trim();
  if (!query) return [];

  const rows = await sqlAll<{
    chunk_id: string;
    vector_json: string | null;
    azure_work_item_id: string | null;
    work_item_type: string | null;
    document_name: string | null;
    content: string;
    metadata_json: string | null;
  }>(
    `
      SELECT e.chunk_id, e.vector_json, dc.azure_work_item_id, dc.work_item_type,
             dc.document_name, dc.content, dc.metadata_json
      FROM embeddings e
      JOIN document_chunks dc ON dc.id = e.chunk_id
      WHERE e.project_id = @projectId
        AND e.azure_project_id = @azureProjectId
        AND e.source_type = @sourceType
        AND e.vector_reference = @vectorReference
        AND ${ACTIVE_CHUNK_FILTER_SQL}
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceType: CHUNK_SOURCE_TYPE,
      vectorReference: input.provider.vectorReference,
    },
  );
  if (!rows.length) return [];

  const [queryVector] = await input.provider.embed([query], "query");
  const maxChunksPerWorkItem = Math.max(1, Math.trunc(input.maxChunksPerWorkItem ?? 1));
  const scored = rows
    .map((row) => ({
      id: row.chunk_id,
      azure_work_item_id: row.azure_work_item_id,
      work_item_type: row.work_item_type,
      document_name: row.document_name,
      content: row.content,
      metadata_json: row.metadata_json,
      similarity: cosineSimilarity(queryVector, parseVectorJson(row.vector_json)),
    }))
    .filter((row) => row.similarity > 0)
    .sort((first, second) => second.similarity - first.similarity || first.id.localeCompare(second.id));

  const countsByWorkItem = new Map<string, number>();
  const selected: SemanticContextChunk[] = [];
  for (const row of scored) {
    if (selected.length >= input.topK) break;
    const key = row.azure_work_item_id ?? "__missing_work_item_id__";
    const count = countsByWorkItem.get(key) ?? 0;
    if (count >= maxChunksPerWorkItem) continue;
    countsByWorkItem.set(key, count + 1);
    selected.push(row);
  }
  return selected;
}

// project_knowledge_entries has no stable per-save id (refreshProjectKnowledgeSearchIndex
// fully deletes and reinserts every entry, with a fresh random id, on every knowledge
// base save), so embeddings for it are keyed on a synthetic id derived from each
// entry's natural identity (category + entry_key) instead. This makes the embedding
// row's identity independent of the entry table's per-save id churn.
function knowledgeEmbeddingChunkId(projectId: string, category: string, entryKey: string) {
  return `kb:${projectId}:${category}:${entryKey}`;
}

/**
 * Embeds every current project_knowledge_entries row and removes embeddings for
 * entries no longer present. Unlike syncProjectChunkEmbeddings, this always
 * re-embeds every entry on every call rather than skipping unchanged ones: knowledge
 * bases are small (tens to low-hundreds of entries) and compiled infrequently by a
 * deliberate owner/admin action, unlike the continuously-synced chunk corpus, so
 * incremental skip isn't worth the extra content-hash tracking it would need. Meant
 * to be called once per knowledge base save (see publishProjectKnowledgeDraft),
 * after refreshProjectKnowledgeSearchIndex has already written the current entries.
 */
export async function syncProjectKnowledgeEntryEmbeddings(input: {
  scope: ProjectScope;
  provider: EmbeddingProvider;
}) {
  const scope = assertProjectScope(input.scope);
  const entries = await sqlAll<{ category: string; entry_key: string; content: string }>(
    `
      SELECT category, entry_key, content
      FROM project_knowledge_entries
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY category, entry_key
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
  );

  const currentChunkIds = entries.map((entry) =>
    knowledgeEmbeddingChunkId(scope.projectId, entry.category, entry.entry_key),
  );
  const removedCount = await sqlRun(
    `
      DELETE FROM embeddings
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND source_type = @sourceType
        AND NOT (chunk_id = ANY(@currentChunkIds))
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceType: KNOWLEDGE_SOURCE_TYPE,
      currentChunkIds,
    },
  );

  let embeddedEntryCount = 0;
  for (let start = 0; start < entries.length; start += MAX_EMBED_BATCH_SIZE) {
    const batch = entries.slice(start, start + MAX_EMBED_BATCH_SIZE);
    const vectors = await input.provider.embed(batch.map((entry) => entry.content), "document");
    const now = nowIso();
    for (const [index, entry] of batch.entries()) {
      await sqlRun(
        `
          INSERT INTO embeddings (
            id, project_id, azure_project_id, chunk_id, source_type, provider, model,
            vector_reference, vector_json, created_at, updated_at
          ) VALUES (
            @id, @projectId, @azureProjectId, @chunkId, @sourceType, @provider, @model,
            @vectorReference, @vectorJson, @createdAt, @updatedAt
          )
          ON CONFLICT (source_type, chunk_id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            vector_reference = excluded.vector_reference,
            vector_json = excluded.vector_json,
            updated_at = excluded.updated_at
        `,
        {
          id: createId("emb"),
          projectId: scope.projectId,
          azureProjectId: scope.azureProjectId,
          chunkId: knowledgeEmbeddingChunkId(scope.projectId, entry.category, entry.entry_key),
          sourceType: KNOWLEDGE_SOURCE_TYPE,
          provider: input.provider.name,
          model: input.provider.model,
          vectorReference: input.provider.vectorReference,
          vectorJson: JSON.stringify(vectors[index]),
          createdAt: now,
          updatedAt: now,
        },
      );
      embeddedEntryCount += 1;
    }
  }

  return {
    embeddedEntryCount,
    removedEmbeddingCount: removedCount,
  };
}

/** Same approach as searchProjectContextByEmbedding, over project_knowledge_entries. */
export async function searchProjectKnowledgeByEmbedding(input: {
  scope: ProjectScope;
  provider: EmbeddingProvider;
  query: string;
  topK: number;
}): Promise<SemanticKnowledgeEntry[]> {
  const scope = assertProjectScope(input.scope);
  const query = input.query.trim();
  if (!query) return [];

  const rows = await sqlAll<{
    vector_json: string | null;
    entry_id: string;
    category: string;
    entry_key: string;
    title: string;
    content: string;
    source_work_item_ids: string;
    evidence: string;
  }>(
    `
      SELECT e.vector_json, pke.id AS entry_id, pke.category, pke.entry_key, pke.title,
             pke.content, pke.source_work_item_ids, pke.evidence
      FROM embeddings e
      JOIN project_knowledge_entries pke
        ON e.chunk_id = 'kb:' || @projectId || ':' || pke.category || ':' || pke.entry_key
       AND pke.project_id = @projectId
       AND pke.azure_project_id = @azureProjectId
      WHERE e.project_id = @projectId
        AND e.azure_project_id = @azureProjectId
        AND e.source_type = @sourceType
        AND e.vector_reference = @vectorReference
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceType: KNOWLEDGE_SOURCE_TYPE,
      vectorReference: input.provider.vectorReference,
    },
  );
  if (!rows.length) return [];

  const [queryVector] = await input.provider.embed([query], "query");
  return rows
    .map((row) => ({
      entry_id: row.entry_id,
      category: row.category,
      entry_key: row.entry_key,
      title: row.title,
      content: row.content,
      source_work_item_ids: row.source_work_item_ids,
      evidence: row.evidence,
      similarity: cosineSimilarity(queryVector, parseVectorJson(row.vector_json)),
    }))
    .filter((row) => row.similarity > 0)
    .sort((first, second) => second.similarity - first.similarity || first.entry_id.localeCompare(second.entry_id))
    .slice(0, input.topK);
}

function parseVectorJson(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number") ? parsed : [];
  } catch {
    return [];
  }
}
