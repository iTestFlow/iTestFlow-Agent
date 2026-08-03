import "server-only";

import { createEmbeddingProvider } from "./embedding-provider";
import { createRerankProvider } from "./rerank-provider";

/**
 * Fire-and-forget startup warm-up for the two pinned local models. Without it, the
 * first request that needs an embedding or a rerank pays the ONNX session load
 * (~0.5s warm-cached) — and on a fresh machine the weight downloads (~131 MB
 * embedding, ~23 MB reranker) — inside a user-facing request.
 *
 * Never throws and never blocks boot: each model warms in its own try/catch, and a
 * failure (offline machine, no disk) only means the first real call pays the cost
 * instead, exactly as before. Callers invoke it as `void warmLocalModels()` after
 * their own startup has succeeded.
 */
export async function warmLocalModels(): Promise<void> {
  await warm("embedding model", () => createEmbeddingProvider().embed(["warmup"], "query"));
  await warm("reranker", () => createRerankProvider().rerank("warmup", ["warmup"]));
}

async function warm(label: string, run: () => Promise<unknown>): Promise<void> {
  const started = performance.now();
  try {
    await run();
    console.log(`[startup] warmed ${label} in ${Math.round(performance.now() - started)}ms`);
  } catch (error) {
    console.warn(`[startup] ${label} warm-up failed; the first real call will retry.`, error);
  }
}
