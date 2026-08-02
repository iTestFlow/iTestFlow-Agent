import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { createId, nowIso, sqlAll, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { MAX_EMBED_BATCH_SIZE, type EmbeddingProvider } from "./embedding-provider";
import { cosineSimilarity } from "./hybrid-ranking";
import { metadataFilterParams, workItemPathFilterSql, workItemTypeFilterSql, type MetadataFilter } from "./metadata-filter";

/**
 * Persists chunk embeddings in the `embeddings` table (`vector` holds the raw vector
 * as a native real[]; vector_reference records provider:model so a model change
 * re-embeds). Similarity search loads the active project's vectors and ranks them in
 * process.
 *
 * Vectors are stored as real[] rather than JSON text deliberately: measured on real
 * data, JSON text cost ~16.2 KB per 768-dimension vector and dominated query time via
 * JSON.parse. real[] is ~3 KB and is decoded straight into a number array by the pg
 * driver. The scan is still O(n) per query, which is adequate for the corpus sizes
 * this product indexes; if that stops holding, moving top-K into Postgres (pgvector +
 * HNSW) is the next step and would replace this scan rather than tune it.
 *
 * The store is an implementation detail behind retrieveStoredProjectContext's hybrid
 * retrieval; failures here degrade to full-text and trigram search.
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

/**
 * Text-recipe versions, kept separate per pipeline and appended to the model's own
 * vector reference.
 *
 * Two vectors are comparable only when the model AND the text fed to it match, so a
 * change to what gets embedded must invalidate stored vectors. Versioning that per
 * pipeline matters because the two pipelines self-heal very differently: chunk vectors
 * are rebuilt by every scheduled context sync, while knowledge-entry vectors are only
 * rebuilt when an admin publishes a knowledge draft. A single shared version would
 * mean a chunk-only recipe change silently strips the Business Owner Assistant's
 * knowledge search of its semantic signal until someone happens to publish.
 *
 * chunk v3: title prefix + non-semantic header lines stripped (embeddableChunkText).
 * chunk v4: field-aware chunking — title/description/AC/tags as separate units.
 */
const CHUNK_RECIPE_VERSION = "v4";
// The knowledge recipe has never changed, so it stays on the unsuffixed reference that
// predates this versioning scheme. Introducing a suffix here would invalidate every
// stored knowledge vector for a recipe that is byte-identical — and because knowledge
// vectors are only rebuilt when an admin publishes a draft, the assistant would lose
// semantic knowledge search until that happened. Give this a version only when the
// knowledge text composition actually changes.
const KNOWLEDGE_RECIPE_VERSION: string | null = null;

function withRecipe(provider: EmbeddingProvider, recipe: string | null): string {
  return recipe ? `${provider.vectorReference}:${recipe}` : provider.vectorReference;
}

export function chunkVectorReference(provider: EmbeddingProvider): string {
  return withRecipe(provider, CHUNK_RECIPE_VERSION);
}

function knowledgeVectorReference(provider: EmbeddingProvider): string {
  return withRecipe(provider, KNOWLEDGE_RECIPE_VERSION);
}

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
 * Header lines in the composed work-item text that carry no retrievable meaning:
 * an opaque numeric id, a timestamp, and paths that are frequently identical across
 * an entire project. They are dropped before embedding.
 *
 * Measured on a real 1,085-item project: these lines were a median 29% of every
 * chunk's text, and `Area path` was byte-identical on all 1,085 items. Embedding a
 * near-constant preamble into every vector pulls the whole corpus toward one region
 * and compresses the usable similarity range — which is why unrelated content here
 * still scores ~0.4-0.5 and why no absolute relevance threshold works.
 *
 * Removing them measured (query = each work item's own title, 24 real chunks):
 *   mean margin over the runner-up  0.144 -> 0.171  (+18.7%)
 *   worst-case margin               0.047 -> 0.062  (+32%)
 *   embedded characters                            -24.7%
 * Top-1 accuracy was 24/24 both ways; the gain is in separation, not raw hit rate.
 *
 * Only the EMBEDDED projection is trimmed. document_chunks.content is untouched, so
 * full-text and trigram search still match these fields and the UI still shows them.
 */
const NON_SEMANTIC_HEADER_LINE = /^(Work item ID|Area path|Iteration path|Updated):/;

/**
 * The exact text embedded for a chunk: its work item's title, then the chunk body
 * with non-semantic header lines removed.
 *
 * The title has to be repeated on every chunk because chunking splits one work item's
 * composed text into pieces — only the first piece contains the "Title: ..." line, so
 * a continuation chunk is otherwise an anonymous fragment with no indication of what
 * it describes. Both lexical signals already avoid this: document_chunks_fts indexes
 * `title || content` per row for full-text and trigram alike. Embedding content alone
 * left semantic search as the only signal blind to the title on continuation chunks.
 */
export function embeddableChunkText(chunk: { content: string; document_name: string | null }): string {
  const body = chunk.content
    .split("\n")
    .filter((line) => !NON_SEMANTIC_HEADER_LINE.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const title = chunk.document_name?.trim();
  // A chunk that was nothing but header lines still needs *something* to embed;
  // fall back to the original content rather than sending an empty string.
  const text = body || chunk.content;
  return title ? `${title}\n\n${text}` : text;
}

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

  // A chunk is pending when it has no embedding at the current vector_reference, its
  // stored vector is NULL, OR its embedding predates the chunk's own last content
  // change (document_chunks.id is deterministic and reused across a content edit that
  // doesn't change the chunk count, so existence alone isn't enough — the stale vector
  // would otherwise be reused forever). document_chunks.updated_at only advances on a
  // real content change (unchanged content takes an early-continue in the indexing
  // loop that never touches the row), so this comparison is safe.
  //
  // The NULL-vector case is the recovery path for a row whose stored value could not
  // be converted (see migration 1710000027000): without it such a row would keep its
  // NULL vector forever, silently scoring 0 in every search.
  const pending = await sqlAll<{ id: string; content: string; document_name: string | null }>(
    `
      SELECT dc.id, dc.content, dc.document_name
      FROM document_chunks dc
      LEFT JOIN embeddings e
        ON e.chunk_id = dc.id
       AND e.source_type = @sourceType
       AND e.vector_reference = @vectorReference
      WHERE ${ACTIVE_CHUNK_FILTER_SQL}
        AND (e.id IS NULL OR e.vector IS NULL OR e.updated_at < dc.updated_at)
      -- Length first so each persisted batch below holds similar-length chunks: the
      -- provider batches for inference within what it is handed, and a batch pads
      -- every sequence to its longest member. Ordering by id instead interleaves
      -- 200- and 2,000-character chunks and pays the long shape for all of them.
      -- length(content) is a proxy for the embedded projection (embeddableChunkText
      -- strips header lines and prefixes the title) but tracks it closely enough, and
      -- costs nothing here. id breaks ties so batching stays deterministic.
      ORDER BY length(dc.content), dc.id
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceType: CHUNK_SOURCE_TYPE,
      vectorReference: chunkVectorReference(input.provider),
    },
  );

  // Embed and persist one batch at a time instead of embedding the whole pending list
  // and inserting only after everything succeeds: if a later batch fails, every batch
  // before it is already durably saved and won't be redone (or lost) on the next sync.
  let embeddedChunkCount = 0;
  for (let start = 0; start < pending.length; start += MAX_EMBED_BATCH_SIZE) {
    const batch = pending.slice(start, start + MAX_EMBED_BATCH_SIZE);
    const vectors = await input.provider.embed(batch.map(embeddableChunkText), "document");
    const now = nowIso();
    // One statement per batch rather than one per chunk: a full re-embed of this
    // project's 1,155 chunks spent ~22s of its ~167s outside inference, most of it
    // round trips. Row order still pairs vectors[index] with batch[index].
    const params: Record<string, unknown> = {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceType: CHUNK_SOURCE_TYPE,
      provider: input.provider.name,
      model: input.provider.model,
      vectorReference: chunkVectorReference(input.provider),
      createdAt: now,
      updatedAt: now,
    };
    const rows = batch.map((chunk, index) => {
      params[`id${index}`] = createId("emb");
      params[`chunkId${index}`] = chunk.id;
      params[`vector${index}`] = vectors[index];
      return `(@id${index}, @projectId, @azureProjectId, @chunkId${index}, @sourceType,`
        + ` @provider, @model, @vectorReference, @vector${index}::real[], @createdAt, @updatedAt)`;
    });
    await sqlRun(
      `
        INSERT INTO embeddings (
          id, project_id, azure_project_id, chunk_id, source_type, provider, model,
          vector_reference, vector, created_at, updated_at
        ) VALUES ${rows.join(", ")}
        ON CONFLICT (source_type, chunk_id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          vector_reference = excluded.vector_reference,
          vector = excluded.vector,
          updated_at = excluded.updated_at
      `,
      params,
    );
    embeddedChunkCount += batch.length;
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
  /** Opt-in restriction by work item type / area path / iteration path. Never state. */
  filter?: MetadataFilter;
}): Promise<SemanticContextChunk[]> {
  const scope = assertProjectScope(input.scope);
  const query = input.query.trim();
  if (!query) return [];

  const rows = await sqlAll<{
    chunk_id: string;
    vector: number[] | null;
    azure_work_item_id: string | null;
    work_item_type: string | null;
    document_name: string | null;
    content: string;
    metadata_json: string | null;
  }>(
    `
      SELECT e.chunk_id, e.vector, dc.azure_work_item_id, dc.work_item_type,
             dc.document_name, dc.content, dc.metadata_json
      FROM embeddings e
      JOIN document_chunks dc ON dc.id = e.chunk_id
      WHERE e.project_id = @projectId
        AND e.azure_project_id = @azureProjectId
        AND e.source_type = @sourceType
        AND e.vector_reference = @vectorReference
        AND ${ACTIVE_CHUNK_FILTER_SQL}
        AND ${workItemTypeFilterSql("dc.")}
        AND ${workItemPathFilterSql(
          { projectId: "dc.project_id", azureProjectId: "dc.azure_project_id", azureWorkItemId: "dc.azure_work_item_id" },
          "mf_embed",
        )}
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      sourceType: CHUNK_SOURCE_TYPE,
      vectorReference: chunkVectorReference(input.provider),
      ...metadataFilterParams(input.filter),
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
      similarity: cosineSimilarity(queryVector, row.vector ?? []),
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
            vector_reference, vector, created_at, updated_at
          ) VALUES (
            @id, @projectId, @azureProjectId, @chunkId, @sourceType, @provider, @model,
            @vectorReference, @vector::real[], @createdAt, @updatedAt
          )
          ON CONFLICT (source_type, chunk_id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            vector_reference = excluded.vector_reference,
            vector = excluded.vector,
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
          vectorReference: knowledgeVectorReference(input.provider),
          vector: vectors[index],
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
    vector: number[] | null;
    entry_id: string;
    category: string;
    entry_key: string;
    title: string;
    content: string;
    source_work_item_ids: string;
    evidence: string;
  }>(
    `
      SELECT e.vector, pke.id AS entry_id, pke.category, pke.entry_key, pke.title,
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
      vectorReference: knowledgeVectorReference(input.provider),
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
      similarity: cosineSimilarity(queryVector, row.vector ?? []),
    }))
    .filter((row) => row.similarity > 0)
    .sort((first, second) => second.similarity - first.similarity || first.entry_id.localeCompare(second.entry_id))
    .slice(0, input.topK);
}
