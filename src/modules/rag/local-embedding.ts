import "server-only";

import path from "node:path";

/**
 * In-process embedding inference via transformers.js (ONNX). This is the zero-setup
 * local backend: no external model server, the model auto-downloads on first use and
 * is cached under data/model-cache. The heavy runtime is loaded lazily with a dynamic
 * import so deployments that use a different (or no) embedding backend never pay for
 * it, and next.config.ts marks the package server-external so webpack leaves its
 * native ONNX binaries alone.
 */

export type LocalEmbeddingDtype = "q8" | "fp16" | "fp32" | "q4";

type FeatureExtractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorKey = "";
let extractorPromise: Promise<FeatureExtractor> | null = null;

export async function embedWithLocalModel(input: {
  model: string;
  dtype: LocalEmbeddingDtype;
  texts: string[];
}): Promise<number[][]> {
  const key = `${input.model}::${input.dtype}`;
  if (!extractorPromise || extractorKey !== key) {
    extractorKey = key;
    extractorPromise = createExtractor(input.model, input.dtype).catch((error) => {
      // A failed load (offline first run, bad model id) must not poison the
      // singleton forever; the next call retries.
      extractorPromise = null;
      throw error;
    });
  }
  const extract = await extractorPromise;
  const output = await extract(input.texts, { pooling: "mean", normalize: true });
  return output.tolist();
}

async function createExtractor(model: string, dtype: LocalEmbeddingDtype): Promise<FeatureExtractor> {
  const transformers = await import("@huggingface/transformers");
  transformers.env.cacheDir = path.join(process.cwd(), "data", "model-cache");
  const pipeline = await transformers.pipeline("feature-extraction", model, { dtype });
  return pipeline as unknown as FeatureExtractor;
}
