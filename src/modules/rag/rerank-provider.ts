import "server-only";

import { rerankWithLocalModel, type LocalRerankDtype } from "./local-rerank";

/**
 * The reranking backend for retrieval precision: a local cross-encoder
 * (Xenova/ms-marco-MiniLM-L-6-v2, an ONNX build of cross-encoder/ms-marco-MiniLM-L-6-v2)
 * runs in-process via transformers.js/ONNX, auto-downloading quantized weights (~23 MB,
 * well under the embedding model's ~131 MB) into data/model-cache on first use -- the
 * same zero-config local-model pattern embedding-provider.ts uses.
 *
 * Like the embedding model, this is deliberately not pluggable and not configurable.
 * Retrieval quality is a property of the product, not a deployment choice: an operator
 * who turns reranking off silently gets worse answers with nothing in the product saying
 * so, and a second reranker model would mean two deployments disagreeing about what
 * "relevant" means for the same corpus. One pinned model keeps behaviour identical
 * everywhere.
 *
 * Callers still handle a failed rerank: hybrid search catches rerank errors and keeps
 * the pre-rerank fused order, so a machine that cannot download the weights (offline,
 * air-gapped) loses precision but keeps working.
 */

export type RerankProvider = {
  name: "local";
  model: string;
  /** Scores align 1:1 with `texts`, in the same order; the caller does the sorting. */
  rerank(query: string, texts: string[]): Promise<number[]>;
};

export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
export const RERANK_DTYPE: LocalRerankDtype = "q8";

// A rerank batch runs each (query, passage) pair through its own full transformer
// forward pass with no computation shared across items -- a bi-encoder embeds each
// passage once and reuses it against every future query, a cross-encoder cannot.
// Pairs also pad to the batch's longest COMBINED sequence length. Smaller than
// MAX_EMBED_BATCH_SIZE (64) to keep peak memory bounded against that higher per-item
// cost; the wide candidate pool this feeds from is itself capped at 50 (see
// hybrid-chunk-search.ts), so this still means at most a handful of batches per call.
export const MAX_RERANK_BATCH_SIZE = 16;
// Document chunks run ~2000 chars; this bounds pathological inputs cheaply before they
// reach the tokenizer's own truncation (this model's max_position_embeddings is 512
// tokens, covering query + passage combined).
const MAX_RERANK_INPUT_CHARS = 2000;
// The query gets a much tighter cap than passages, and deliberately so: the 512-token
// pair window (~2000 chars) is shared, and nothing in tokenization prioritizes keeping
// the passage visible — a requirement-length query (workflow auto-context passes
// title+description+criteria joined, unbounded) could consume essentially the whole
// window and leave the model scoring the query against a stump of each passage. 600
// chars (~150 tokens) keeps the query under a third of the window; its discriminative
// content is front-loaded by construction (title, then the opening description
// sentences), while passages have to survive from mid-chunk. Exported for tests.
export const MAX_RERANK_QUERY_CHARS = 600;

/**
 * The rerank provider. Always available — there is no "off" and no null return;
 * callers that need to disable reranking (tests) inject null at the seam instead.
 */
export function createRerankProvider(): RerankProvider {
  return {
    name: "local",
    model: RERANK_MODEL,
    rerank: (query, texts) => rerankInBatches(query, texts),
  };
}

async function rerankInBatches(query: string, texts: string[]): Promise<number[]> {
  if (!texts.length) return [];
  const preparedQuery = query.slice(0, MAX_RERANK_QUERY_CHARS);
  const preparedTexts = texts.map((text) => text.slice(0, MAX_RERANK_INPUT_CHARS));
  const scores: number[] = [];
  for (let start = 0; start < preparedTexts.length; start += MAX_RERANK_BATCH_SIZE) {
    const batch = preparedTexts.slice(start, start + MAX_RERANK_BATCH_SIZE);
    const batchScores = await rerankWithLocalModel({
      model: RERANK_MODEL,
      dtype: RERANK_DTYPE,
      query: preparedQuery,
      texts: batch,
    });
    assertScoreCount(batchScores, batch.length);
    scores.push(...batchScores);
  }
  return scores;
}

function assertScoreCount(scores: number[], expected: number) {
  if (scores.length !== expected) {
    throw new Error(`Local reranker returned ${scores.length} scores for ${expected} inputs.`);
  }
}
