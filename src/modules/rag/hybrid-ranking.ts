/**
 * Pure ranking math for hybrid retrieval: cosine similarity over embedding vectors
 * and reciprocal rank fusion (RRF) to combine lexical and semantic result lists
 * without calibrating their unrelated score scales against each other.
 */

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const RRF_DEFAULT_K = 60;

export type FusedResult<TItem> = {
  item: TItem;
  score: number;
};

/**
 * Reciprocal rank fusion: score(item) = sum over lists of 1 / (k + rank), rank
 * 1-based within each list. Items appearing in several lists accumulate score, so
 * agreement between retrievers outranks a high position in a single list. The first
 * list occurrence of a key supplies the returned item instance. Ties break by first
 * appearance so fusion output is deterministic.
 */
export function fuseByReciprocalRank<TItem>(input: {
  lists: TItem[][];
  getKey: (item: TItem) => string;
  k?: number;
}): FusedResult<TItem>[] {
  const k = input.k ?? RRF_DEFAULT_K;
  const fused = new Map<string, FusedResult<TItem> & { firstSeen: number }>();
  let seenCounter = 0;

  for (const list of input.lists) {
    list.forEach((item, index) => {
      const key = input.getKey(item);
      if (!key) return;
      const contribution = 1 / (k + index + 1);
      const existing = fused.get(key);
      if (existing) {
        existing.score += contribution;
        return;
      }
      fused.set(key, { item, score: contribution, firstSeen: seenCounter });
      seenCounter += 1;
    });
  }

  return Array.from(fused.values())
    .sort((first, second) => second.score - first.score || first.firstSeen - second.firstSeen)
    .map(({ item, score }) => ({ item, score }));
}
