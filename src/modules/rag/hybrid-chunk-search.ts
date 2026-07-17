import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { sqlAll } from "@/modules/shared/infrastructure/database/db";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
import { searchProjectContextByEmbedding } from "./embedding-store.service";
import { searchProjectContextByTrigram } from "./trigram-search";
import { fuseByReciprocalRank } from "./hybrid-ranking";

/**
 * Shared FTS + semantic + trigram chunk search, used by both
 * retrieveStoredProjectContext (workflow auto-context) and the Business Owner
 * Assistant chatbot's searchContext. Extracted because both call sites need the
 * exact same ranking/fusion/per-work-item-cap logic and would otherwise drift.
 */

export type HybridChunkRow = {
  id: string;
  azure_work_item_id: string | null;
  work_item_type: string | null;
  document_name: string | null;
  content: string;
  metadata_json: string | null;
};

export type FusedChunkResult = {
  row: HybridChunkRow;
  score: number;
};

export async function searchProjectChunksHybrid(input: {
  scope: ProjectScope;
  /** Pre-built via buildFtsQuery; callers already branch on an empty query before calling. */
  ftsQuery: string;
  /** Original free text, used for semantic + trigram matching. */
  rawQuery: string;
  topK: number;
  maxChunksPerWorkItem?: number;
  /** undefined -> resolve the deployment-configured backend; null -> force semantic off (tests). */
  embeddingProvider?: EmbeddingProvider | null;
}): Promise<FusedChunkResult[]> {
  const scope = assertProjectScope(input.scope);
  const maxChunksPerWorkItem = Math.max(1, Math.trunc(input.maxChunksPerWorkItem ?? 1));

  let ftsRows: Array<HybridChunkRow & { rank: number }> = [];
  try {
    ftsRows = await sqlAll<HybridChunkRow & { rank: number }>(
      `
        WITH ranked AS (
          SELECT chunk_id, azure_work_item_id, work_item_type, title, content, metadata_json,
                 ts_rank_cd(tsv, to_tsquery('simple', @ftsQuery)) AS rank,
                 ROW_NUMBER() OVER (
                   PARTITION BY azure_work_item_id
                   ORDER BY ts_rank_cd(tsv, to_tsquery('simple', @ftsQuery)) DESC, chunk_id ASC
                 ) AS work_item_rank
          FROM document_chunks_fts
          WHERE tsv @@ to_tsquery('simple', @ftsQuery)
            AND project_id = @projectId
            AND azure_project_id = @azureProjectId
        )
        SELECT chunk_id AS id, azure_work_item_id, work_item_type, title AS document_name,
               content, metadata_json, rank
        FROM ranked
        WHERE work_item_rank <= @maxChunksPerWorkItem
        ORDER BY rank DESC, azure_work_item_id ASC, chunk_id ASC
        LIMIT @limit
      `,
      {
        ftsQuery: input.ftsQuery,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        maxChunksPerWorkItem,
        limit: input.topK,
      },
    );
  } catch (error) {
    console.error("Hybrid chunk search: full-text search failed.", error);
  }

  const embeddingProvider =
    input.embeddingProvider !== undefined ? input.embeddingProvider : createEmbeddingProvider();
  let semanticRows: HybridChunkRow[] = [];
  if (embeddingProvider) {
    try {
      semanticRows = await searchProjectContextByEmbedding({
        scope,
        provider: embeddingProvider,
        query: input.rawQuery,
        topK: input.topK,
        maxChunksPerWorkItem,
      });
    } catch (error) {
      console.error("Hybrid chunk search: semantic search failed; continuing without it.", error);
    }
  }

  let trigramRows: HybridChunkRow[] = [];
  try {
    trigramRows = await searchProjectContextByTrigram({
      scope,
      query: input.rawQuery,
      topK: input.topK,
      maxChunksPerWorkItem,
    });
  } catch (error) {
    console.error("Hybrid chunk search: trigram search failed; continuing without it.", error);
  }

  // Most deployments run with EMBEDDINGS_PROVIDER=off, so this is the common path.
  // Keep the raw ts_rank_cd ordering here instead of running a single-list fusion
  // through RRF, which would flatten its real score spread into near-identical
  // normalized scores for no reason.
  if (!semanticRows.length && !trigramRows.length) {
    return applyPerWorkItemCap(
      ftsRows.map((row) => ({ row, score: row.rank })),
      maxChunksPerWorkItem,
      input.topK,
    );
  }

  const fused = fuseByReciprocalRank<HybridChunkRow>({
    lists: [ftsRows, semanticRows, trigramRows].filter((list) => list.length > 0),
    getKey: (row) => row.id,
  });
  return applyPerWorkItemCap(
    fused.map(({ item, score }) => ({ row: item, score })),
    maxChunksPerWorkItem,
    input.topK,
  );
}

// Each source list is already capped per work item on its own (SQL ROW_NUMBER for
// FTS/trigram, an equivalent JS pass for semantic), but combining lists can still
// stack multiple sources' hits for the same work item past the cap -- e.g. one FTS
// hit + one semantic hit + one trigram hit for the same item. Re-apply the cap once
// more over the combined/fused ranking.
function applyPerWorkItemCap(
  ranked: FusedChunkResult[],
  maxChunksPerWorkItem: number,
  topK: number,
): FusedChunkResult[] {
  const countsByWorkItem = new Map<string, number>();
  const selected: FusedChunkResult[] = [];
  for (const entry of ranked) {
    if (selected.length >= topK) break;
    const key = entry.row.azure_work_item_id ?? "__missing_work_item_id__";
    const count = countsByWorkItem.get(key) ?? 0;
    if (count >= maxChunksPerWorkItem) continue;
    countsByWorkItem.set(key, count + 1);
    selected.push(entry);
  }
  return selected;
}
