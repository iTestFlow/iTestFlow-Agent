import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { sqlAll } from "@/modules/shared/infrastructure/database/db";

/**
 * PostgreSQL trigram (pg_trgm) search: a third retrieval signal alongside full-text
 * search and semantic search, meant to catch compound-word/infix matches
 * to_tsquery prefix matching misses (e.g. "flow" matching "workflow"). Query-side
 * only -- indexing is handled entirely by the trigram GIN indexes added in
 * migrations/1710000023000_trigram_search.js; no separate sync step is needed since
 * Postgres maintains those indexes automatically as document_chunks_fts /
 * project_knowledge_entries_fts rows are inserted.
 */

// Trigram similarity is unreliable/noisy below ~3 characters (too few real trigrams
// to compare); this mirrors buildFtsQuery's own per-token length filter, applied to
// the whole phrase since trigram matching is character-based, not word-based.
export const MIN_TRIGRAM_QUERY_LENGTH = 3;

/**
 * Prepares a raw query phrase for trigram comparison: trim, collapse whitespace,
 * lowercase (matching the lower(...) expression the trigram indexes are built on).
 * Deliberately does NOT reuse buildFtsQuery's tokenized/boolean-operator output
 * ("login:* | flow:*") -- trigram matching wants the natural phrase, not a set of
 * independent OR'd tokens full of syntax characters that aren't part of the text.
 */
export function prepareTrigramQuery(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized.length >= MIN_TRIGRAM_QUERY_LENGTH ? normalized : null;
}

export type TrigramContextChunk = {
  id: string;
  azure_work_item_id: string | null;
  work_item_type: string | null;
  document_name: string | null;
  content: string;
  metadata_json: string | null;
  similarity: number;
};

export type TrigramKnowledgeEntry = {
  entry_id: string;
  category: string;
  entry_key: string;
  title: string;
  content: string;
  source_work_item_ids: string;
  evidence: string;
  similarity: number;
};

/**
 * Ranks document_chunks_fts rows by word_similarity() against the query, capped per
 * work item. Uses word_similarity()/`<%` rather than plain similarity()/`%`: `<%` is
 * Postgres's documented operator for "does this short string occur, sufficiently
 * similarly, as some substring of this longer text" -- plain similarity() compares
 * whole-string trigram-set overlap, which is unreliable for a short query against a
 * large title+content blob. Both are GIN-accelerated via gin_trgm_ops. No internal
 * try/catch, matching searchProjectContextByEmbedding's contract of letting the
 * caller centralize per-source resilience.
 */
export async function searchProjectContextByTrigram(input: {
  scope: ProjectScope;
  query: string;
  topK: number;
  maxChunksPerWorkItem?: number;
}): Promise<TrigramContextChunk[]> {
  const scope = assertProjectScope(input.scope);
  const trigramQuery = prepareTrigramQuery(input.query);
  if (!trigramQuery) return [];
  const maxChunksPerWorkItem = Math.max(1, Math.trunc(input.maxChunksPerWorkItem ?? 1));

  return sqlAll<TrigramContextChunk>(
    `
      WITH ranked AS (
        SELECT chunk_id, azure_work_item_id, work_item_type, title, content, metadata_json,
               word_similarity(@trigramQuery, lower(coalesce(title,'') || ' ' || coalesce(content,''))) AS sim,
               ROW_NUMBER() OVER (
                 PARTITION BY azure_work_item_id
                 ORDER BY word_similarity(@trigramQuery, lower(coalesce(title,'') || ' ' || coalesce(content,''))) DESC, chunk_id ASC
               ) AS work_item_rank
        FROM document_chunks_fts
        WHERE @trigramQuery <% lower(coalesce(title,'') || ' ' || coalesce(content,''))
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
      )
      SELECT chunk_id AS id, azure_work_item_id, work_item_type, title AS document_name,
             content, metadata_json, sim AS similarity
      FROM ranked
      WHERE work_item_rank <= @maxChunksPerWorkItem
      ORDER BY sim DESC, azure_work_item_id ASC, chunk_id ASC
      LIMIT @limit
    `,
    {
      trigramQuery,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      maxChunksPerWorkItem,
      limit: input.topK,
    },
  );
}

/** Same approach as searchProjectContextByTrigram, over project_knowledge_entries_fts. */
export async function searchProjectKnowledgeByTrigram(input: {
  scope: ProjectScope;
  query: string;
  topK: number;
}): Promise<TrigramKnowledgeEntry[]> {
  const scope = assertProjectScope(input.scope);
  const trigramQuery = prepareTrigramQuery(input.query);
  if (!trigramQuery) return [];

  return sqlAll<TrigramKnowledgeEntry>(
    `
      SELECT entry_id, category, entry_key, title, content, source_work_item_ids, evidence,
             word_similarity(
               @trigramQuery,
               lower(coalesce(title,'') || ' ' || coalesce(content,'') || ' ' || coalesce(evidence,''))
             ) AS similarity
      FROM project_knowledge_entries_fts
      WHERE @trigramQuery <% lower(coalesce(title,'') || ' ' || coalesce(content,'') || ' ' || coalesce(evidence,''))
        AND project_id = @projectId
        AND azure_project_id = @azureProjectId
      ORDER BY similarity DESC, entry_id ASC
      LIMIT @limit
    `,
    {
      trigramQuery,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      limit: input.topK,
    },
  );
}
