export const CONTEXT_SUGGESTION_MIN_TOP_K = 1;
export const CONTEXT_SUGGESTION_MAX_TOP_K = 25;
export const CONTEXT_SUGGESTION_MIN_CANDIDATE_POOL = 40;
export const CONTEXT_SUGGESTION_MAX_CANDIDATE_POOL = 100;

export function getContextSuggestionFinalLimit(retrievalTopK: number): number {
  if (!Number.isFinite(retrievalTopK)) return 8;
  return Math.min(CONTEXT_SUGGESTION_MAX_TOP_K, Math.max(CONTEXT_SUGGESTION_MIN_TOP_K, Math.trunc(retrievalTopK)));
}

export function getContextSuggestionCandidatePoolSize(retrievalTopK: number): number {
  const finalLimit = getContextSuggestionFinalLimit(retrievalTopK);
  return Math.min(
    CONTEXT_SUGGESTION_MAX_CANDIDATE_POOL,
    Math.max(CONTEXT_SUGGESTION_MIN_CANDIDATE_POOL, finalLimit * 5),
  );
}
