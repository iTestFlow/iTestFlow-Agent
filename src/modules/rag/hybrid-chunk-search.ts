import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { sqlAll } from "@/modules/shared/infrastructure/database/db";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
import { searchProjectContextByEmbedding } from "./embedding-store.service";
import { searchProjectContextByTrigram } from "./trigram-search";
import { fuseByReciprocalRank } from "./hybrid-ranking";
import { dedupeNearDuplicateChunks } from "./near-duplicate-chunks";
import { metadataFilterParams, workItemPathFilterSql, workItemTypeFilterSql, type MetadataFilter } from "./metadata-filter";
import { createRerankProvider, type RerankProvider } from "./rerank-provider";

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
  /** Original free text as the user typed it — used for trigram matching. */
  rawQuery: string;
  /**
   * Text used for SEMANTIC matching, when it should differ from what the user typed.
   * Conversational follow-ups need their prior turns folded in to mean anything;
   * lexical signals must NOT get that treatment (see buildRetrievalQueryWithHistory).
   * Defaults to rawQuery.
   */
  semanticQuery?: string;
  topK: number;
  maxChunksPerWorkItem?: number;
  /** undefined -> resolve the deployment-configured backend; null -> force semantic off (tests). */
  embeddingProvider?: EmbeddingProvider | null;
  /** undefined -> resolve the deployment-configured backend; null -> force rerank off (tests). */
  rerankProvider?: RerankProvider | null;
  /** Opt-in restriction by work item type / area path / iteration path. Never state. */
  filter?: MetadataFilter;
}): Promise<FusedChunkResult[]> {
  const scope = assertProjectScope(input.scope);
  const maxChunksPerWorkItem = Math.max(1, Math.trunc(input.maxChunksPerWorkItem ?? 1));
  const rerankProvider = input.rerankProvider !== undefined ? input.rerankProvider : createRerankProvider();
  // Reranking needs real query text, the same choice semantic search makes: a
  // conversational follow-up needs prior turns folded in to mean anything, but a
  // cross-encoder scores meaning, not tokens, so it gets the same text semantic does.
  const rerankQuery = input.semanticQuery ?? input.rawQuery;

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
            AND ${workItemTypeFilterSql()}
            AND ${workItemPathFilterSql(
              { projectId: "project_id", azureProjectId: "azure_project_id", azureWorkItemId: "azure_work_item_id" },
              "mf_fts",
            )}
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
        ...metadataFilterParams(input.filter),
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
        query: input.semanticQuery ?? input.rawQuery,
        topK: input.topK,
        maxChunksPerWorkItem,
        filter: input.filter,
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
      filter: input.filter,
    });
  } catch (error) {
    console.error("Hybrid chunk search: trigram search failed; continuing without it.", error);
  }

  // Neither extra signal contributed (trigram found nothing, or semantic is off/
  // unavailable/failed) — keep the raw ts_rank_cd ordering instead of running a
  // single-list fusion through RRF, which would flatten its real score spread into
  // near-identical normalized scores for no reason.
  if (!semanticRows.length && !trigramRows.length) {
    return finalizeSearchResults({
      ranked: ftsRows.map((row) => ({ row, score: row.rank })),
      query: rerankQuery,
      maxChunksPerWorkItem,
      topK: input.topK,
      rerankProvider,
    });
  }

  const fused = fuseByReciprocalRank<HybridChunkRow>({
    lists: [ftsRows, semanticRows, trigramRows].filter((list) => list.length > 0),
    getKey: (row) => row.id,
  });
  return finalizeSearchResults({
    ranked: fused.map(({ item, score }) => ({ row: item, score })),
    query: rerankQuery,
    maxChunksPerWorkItem,
    topK: input.topK,
    rerankProvider,
  });
}

// Widen the reranker's candidate pool past the caller's requested topK: reranking a
// pool no larger than topK could only ever reorder results the caller was already
// going to receive, never surface a chunk RRF/ts_rank_cd ranked just outside the
// cutoff. Ceiling bounds rerank cost when a caller requests a large topK.
const RERANK_POOL_WIDTH_MULTIPLIER = 3;
const RERANK_POOL_CEILING = 50;
// How many of the pool's candidates get SCORED, as opposed to returned. A cross-
// encoder forward pass costs ~54ms per max-length pair on the reference hardware, so
// the chatbot's 50-pair pool cost ~2.7s per message; capping inference at the top 24
// fused candidates roughly halves that while leaving result breadth untouched —
// candidates past the cap keep their fused order below the reranked block. 24 covers
// the whole pool for the default workflow topK (8 x 3), so only large-topK callers
// (the chatbot's candidate fetch) are affected, and fused positions 25+ effectively
// never reach a final answer anyway. Deliberately NOT a pool/result cap: TOP_K_MAX is
// 25, and a caller must never receive fewer rows than its topK because of rerank cost.
export const RERANK_MAX_PAIRS = 24;
// A rerank slower than this gets logged; one slower than the timeout is abandoned in
// favor of the already-good fused order — the same degradation the catch below applies
// to a rerank failure, so slowness introduces no new semantics. Measured worst case
// after the pair cap is ~1.3s on the reference hardware, so 1.5s fires only under
// genuine degradation (hung ONNX session, CPU starvation). Honest caveat: the
// abandoned inference still runs to completion on the CPU; only the caller stops
// waiting for it.
export const RERANK_TIMEOUT_MS = 1_500;
const RERANK_SLOW_WARN_MS = 1_000;

/**
 * Races the provider's rerank against the latency budget. Resolves null on timeout;
 * rejections propagate to the caller's existing failure handling.
 */
async function rerankWithinBudget(
  provider: RerankProvider,
  query: string,
  texts: string[],
): Promise<number[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), RERANK_TIMEOUT_MS);
  });
  const scoring = provider.rerank(query, texts);
  // A rejection landing after the budget already won must not surface as an
  // unhandled rejection and crash the process.
  scoring.catch(() => {});
  try {
    return await Promise.race([scoring, budget]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared tail of both return paths above: dedup, optionally rerank, then apply the
 * caller's real per-work-item cap. Isolated so the FTS-only and fused paths -- which
 * differ only in how `ranked` was produced -- cannot drift on what happens after.
 */
async function finalizeSearchResults(input: {
  ranked: FusedChunkResult[];
  query: string;
  maxChunksPerWorkItem: number;
  topK: number;
  rerankProvider: RerankProvider | null;
}): Promise<FusedChunkResult[]> {
  const deduped = dedupeNearDuplicateChunks(
    input.ranked.map((entry) => ({ item: entry, text: entry.row.content })),
  ).map((entry) => entry.item);

  if (!input.rerankProvider) {
    return applyPerWorkItemCap(deduped, input.maxChunksPerWorkItem, input.topK);
  }

  const widePoolSize = Math.min(RERANK_POOL_CEILING, input.topK * RERANK_POOL_WIDTH_MULTIPLIER);
  const candidates = applyPerWorkItemCap(deduped, input.maxChunksPerWorkItem, widePoolSize);
  const scored = candidates.slice(0, RERANK_MAX_PAIRS);
  // Unscored remainder keeps its fused order below the reranked block. Its entries
  // keep fused-scale scores while the block above carries sigmoid scores — the list
  // ORDER is the contract; scores are already documented as non-comparable confidence.
  const passthrough = candidates.slice(RERANK_MAX_PAIRS);

  try {
    const started = performance.now();
    const scores = await rerankWithinBudget(
      input.rerankProvider,
      input.query,
      scored.map((entry) => entry.row.content),
    );
    const durationMs = Math.round(performance.now() - started);
    if (scores === null) {
      console.warn(
        `Hybrid chunk search: rerank exceeded its ${RERANK_TIMEOUT_MS}ms budget for ${scored.length} pairs; keeping fused order.`,
      );
      return applyPerWorkItemCap(deduped, input.maxChunksPerWorkItem, input.topK);
    }
    if (durationMs > RERANK_SLOW_WARN_MS) {
      console.warn(`Hybrid chunk search: rerank took ${durationMs}ms for ${scored.length} pairs.`);
    }
    if (scores.length !== scored.length) {
      throw new Error(`Reranker returned ${scores.length} scores for ${scored.length} candidates.`);
    }
    const reordered = scored
      .map((entry, index) => ({ row: entry.row, score: scores[index]! }))
      .sort((first, second) => second.score - first.score);
    return applyPerWorkItemCap([...reordered, ...passthrough], input.maxChunksPerWorkItem, input.topK);
  } catch (error) {
    // Same resilience pattern as FTS/semantic/trigram above: a broken reranker
    // degrades to the pre-rerank order rather than losing results.
    console.error("Hybrid chunk search: rerank failed; keeping fused order.", error);
    return applyPerWorkItemCap(deduped, input.maxChunksPerWorkItem, input.topK);
  }
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
