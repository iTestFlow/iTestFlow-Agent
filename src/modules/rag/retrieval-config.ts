import "server-only";

const DEFAULT_TOP_K = 8;

/**
 * Context retrieval breadth (top-K). Reads PROJECT_CONTEXT_TOP_K from the
 * environment with a safe default. Decoupled from the legacy filesystem runtime
 * settings so feature routes have no dependency on data/runtime-settings.json.
 */
export function getRetrievalTopK(): number {
  const raw = Number(process.env.PROJECT_CONTEXT_TOP_K ?? DEFAULT_TOP_K);
  if (!Number.isFinite(raw)) return DEFAULT_TOP_K;
  return Math.min(25, Math.max(1, Math.trunc(raw)));
}
