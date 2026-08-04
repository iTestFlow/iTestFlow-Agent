import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { sqlAll, sqlGet } from "@/modules/shared/infrastructure/database/db";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
import { activeUploadedDocumentChunkFilterSql, searchProjectContextByEmbedding } from "./embedding-store.service";
import { searchProjectContextByTrigram } from "./trigram-search";
import { fuseByReciprocalRank } from "./hybrid-ranking";
import { dedupeNearDuplicateChunks } from "./near-duplicate-chunks";
import { metadataFilterParams, workItemPathFilterSql, workItemTypeFilterSql, type MetadataFilter } from "./metadata-filter";
import { createRerankProvider, type RerankProvider } from "./rerank-provider";
import {
  normalizeProjectContextSourceKinds,
  projectContextLogicalSourceKey,
  type ProjectContextSourceKind,
} from "./project-context-source";

/**
 * Shared FTS + semantic + trigram chunk search, used by both
 * retrieveStoredProjectContext (workflow auto-context) and the Business Owner
 * Assistant chatbot's searchContext. Extracted because both call sites need the
 * exact same ranking/fusion/per-work-item-cap logic and would otherwise drift.
 */

export type HybridChunkRow = {
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
  /** Defaults to both active Azure work items and uploaded documents. */
  sourceKinds?: readonly ProjectContextSourceKind[];
  /** Opt-in restriction by work item type / area path / iteration path. Never state. */
  filter?: MetadataFilter;
}): Promise<FusedChunkResult[]> {
  const scope = assertProjectScope(input.scope);
  const requestedSourceKinds = normalizeProjectContextSourceKinds(input.sourceKinds);
  // uploaded_document is part of every caller's default sourceKinds, so without this
  // gate an ADO-only project -- zero uploaded documents, ever -- would still pay the
  // mixed-source 3x candidate widening and 40% diversity cap below on every search.
  // One indexed existence check per call (never per signal) decides whether
  // uploaded_document stays in the effective sourceKinds for the whole call, so
  // candidate limits, SQL branches, and per-source caps all fall back to their exact
  // legacy shape together.
  const hasActiveDocuments = sourceKindsNeedDocumentExistenceCheck(requestedSourceKinds)
    ? await hasActiveUploadedDocumentChunks(scope)
    : false;
  const sourceKinds = narrowSourceKindsForRetrieval(requestedSourceKinds, hasActiveDocuments);
  // The diversity preference needs to see candidates beyond the final topK. If
  // every signal stopped at topK first, a document-heavy lexical score list
  // would never expose the work-item candidates that should fill the other
  // ~60% of a mixed-source result.
  const signalCandidateLimit = sourceDiversityCandidateLimit(input.topK, sourceKinds);
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
          SELECT chunk_id, source_type, azure_work_item_id, work_item_type, document_id,
                 source_document_version_id, title, section, page_number, content, metadata_json,
                 ts_rank_cd(tsv, to_tsquery('simple', @ftsQuery)) AS rank,
                 ROW_NUMBER() OVER (
                   PARTITION BY source_type, COALESCE(azure_work_item_id, document_id)
                   ORDER BY ts_rank_cd(tsv, to_tsquery('simple', @ftsQuery)) DESC, chunk_id ASC
                 ) AS source_rank
          FROM document_chunks_fts
          WHERE tsv @@ to_tsquery('simple', @ftsQuery)
            AND project_id = @projectId
            AND azure_project_id = @azureProjectId
            AND source_type = ANY(@sourceKinds::text[])
            AND ${workItemTypeFilterSql()}
            AND ${workItemPathFilterSql(
              { projectId: "project_id", azureProjectId: "azure_project_id", azureWorkItemId: "azure_work_item_id" },
              "mf_fts",
            )}
        )
        SELECT chunk_id AS id, source_type, azure_work_item_id, work_item_type, document_id,
               source_document_version_id, title AS document_name, section, page_number,
               content, metadata_json, rank
        FROM ranked
        WHERE source_rank <= @maxChunksPerWorkItem
        ORDER BY rank DESC, azure_work_item_id ASC, chunk_id ASC
        LIMIT @limit
      `,
      {
        ftsQuery: input.ftsQuery,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        maxChunksPerWorkItem,
        limit: signalCandidateLimit,
        sourceKinds,
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
        topK: signalCandidateLimit,
        maxChunksPerWorkItem,
        filter: input.filter,
        sourceKinds,
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
      topK: signalCandidateLimit,
      maxChunksPerWorkItem,
      filter: input.filter,
      sourceKinds,
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
      sourceKinds,
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
    sourceKinds,
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
  sourceKinds: readonly ProjectContextSourceKind[];
}): Promise<FusedChunkResult[]> {
  const deduped = dedupeNearDuplicateChunks(
    input.ranked.map((entry) => ({ item: entry, text: entry.row.content })),
  ).map((entry) => entry.item);

  if (!input.rerankProvider) {
    return applyPerSourceCaps(deduped, input.maxChunksPerWorkItem, input.topK, input.sourceKinds);
  }

  const widePoolSize = Math.min(RERANK_POOL_CEILING, input.topK * RERANK_POOL_WIDTH_MULTIPLIER);
  const candidates = applyPerSourceCaps(deduped, input.maxChunksPerWorkItem, widePoolSize, input.sourceKinds);
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
      return applyPerSourceCaps(deduped, input.maxChunksPerWorkItem, input.topK, input.sourceKinds);
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
    return applyPerSourceCaps([...reordered, ...passthrough], input.maxChunksPerWorkItem, input.topK, input.sourceKinds);
  } catch (error) {
    // Same resilience pattern as FTS/semantic/trigram above: a broken reranker
    // degrades to the pre-rerank order rather than losing results.
    console.error("Hybrid chunk search: rerank failed; keeping fused order.", error);
    return applyPerSourceCaps(deduped, input.maxChunksPerWorkItem, input.topK, input.sourceKinds);
  }
}

// Each source list is already capped per work item on its own (SQL ROW_NUMBER for
// FTS/trigram, an equivalent JS pass for semantic), but combining lists can still
// stack multiple sources' hits for the same work item past the cap -- e.g. one FTS
// hit + one semantic hit + one trigram hit for the same item. Re-apply the cap once
// more over the combined/fused ranking.
function applyPerSourceCaps(
  ranked: FusedChunkResult[],
  maxChunksPerWorkItem: number,
  topK: number,
  sourceKinds: readonly ProjectContextSourceKind[],
): FusedChunkResult[] {
  const countsBySource = new Map<string, number>();
  const sourceCapped: FusedChunkResult[] = [];
  for (const entry of ranked) {
    const key = projectContextLogicalSourceKey({
      sourceType: entry.row.source_type,
      azureWorkItemId: entry.row.azure_work_item_id,
      documentId: entry.row.document_id,
    });
    const count = countsBySource.get(key) ?? 0;
    if (count >= maxChunksPerWorkItem) continue;
    countsBySource.set(key, count + 1);
    sourceCapped.push(entry);
  }
  return applyDocumentDiversityCap(sourceCapped, topK, sourceKinds);
}

/**
 * Whether the effective sourceKinds set could even change if this project turned
 * out to have zero active uploaded-document chunks. Kept pure and separate from
 * the EXISTS query itself so "an explicit work-item-only request never touches
 * the database for this" is a fact a unit test can pin directly.
 */
export function sourceKindsNeedDocumentExistenceCheck(
  sourceKinds: readonly ProjectContextSourceKind[],
): boolean {
  return sourceKinds.includes("uploaded_document");
}

/**
 * The narrowing decision itself, isolated from the EXISTS query that feeds it.
 * Every ADO-only project -- the default sourceKinds includes uploaded_document
 * for every caller -- collapses back to the exact legacy work-item-only shape:
 * candidate limits, SQL branches, and per-source caps all derive from
 * sourceKinds, so this is the single point of control for the whole call.
 */
export function narrowSourceKindsForRetrieval(
  sourceKinds: readonly ProjectContextSourceKind[],
  hasActiveDocuments: boolean,
): ProjectContextSourceKind[] {
  if (!sourceKindsNeedDocumentExistenceCheck(sourceKinds) || hasActiveDocuments) {
    return [...sourceKinds];
  }
  return ["azure_work_item"];
}

/**
 * One indexed existence check per searchProjectChunksHybrid call: is there any
 * active uploaded-document chunk in this project at all? Reuses the exact active
 * predicate the retrieval filter itself applies (embedding-store.service.ts)
 * so the two cannot drift. Queries the document_chunks_fts mirror rather than
 * document_chunks: idx_document_chunks_fts_source_document_lookup
 * (migrations/1710000034000) has project_id, azure_project_id, source_type as
 * its leading columns and a `document_id IS NOT NULL` partial predicate that
 * matches this WHERE clause exactly, so a project with thousands of work-item
 * chunks and zero documents still resolves in an index probe.
 */
async function hasActiveUploadedDocumentChunks(scope: ProjectScope): Promise<boolean> {
  const row = await sqlGet<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM document_chunks_fts dcf
        WHERE dcf.project_id = @projectId
          AND dcf.azure_project_id = @azureProjectId
          AND dcf.document_id IS NOT NULL
          AND ${activeUploadedDocumentChunkFilterSql("dcf")}
      ) AS exists
    `,
    { projectId: scope.projectId, azureProjectId: scope.azureProjectId },
  );
  return row?.exists ?? false;
}

export function sourceDiversityCandidateLimit(
  topK: number,
  sourceKinds: readonly ProjectContextSourceKind[],
) {
  if (!sourceKinds.includes("uploaded_document") || !sourceKinds.includes("azure_work_item")) {
    return topK;
  }
  return Math.max(topK, topK * 3);
}

/**
 * Keep an uploaded-document corpus from taking every result slot when active ADO
 * work-item evidence is also available.  This is intentionally soft: a
 * document-only project (or an explicit document-only filter) still receives a
 * full result set instead of an arbitrary 40% ceiling.
 */
export function applyDocumentDiversityCap(
  ranked: FusedChunkResult[],
  topK: number,
  sourceKinds: readonly ProjectContextSourceKind[],
) {
  if (!sourceKinds.includes("uploaded_document") || !sourceKinds.includes("azure_work_item")) {
    return ranked.slice(0, topK);
  }
  const hasWorkItem = ranked.some((entry) => entry.row.source_type === "azure_work_item");
  if (!hasWorkItem) return ranked.slice(0, topK);
  const documentCap = Math.max(1, Math.floor(topK * 0.4));
  let documentCount = 0;
  const selected: FusedChunkResult[] = [];
  const deferredDocuments: FusedChunkResult[] = [];
  for (const entry of ranked) {
    if (selected.length >= topK) break;
    if (entry.row.source_type === "uploaded_document") {
      if (documentCount >= documentCap) {
        deferredDocuments.push(entry);
        continue;
      }
      documentCount += 1;
    }
    selected.push(entry);
  }
  // The cap is a diversity preference, not a reason to return a sparse answer
  // when only a few work items match. Fill unclaimed slots with the deferred
  // document rows in their original relevance order.
  return [...selected, ...deferredDocuments].slice(0, topK);
}
