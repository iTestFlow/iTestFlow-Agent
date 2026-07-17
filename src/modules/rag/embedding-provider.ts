import "server-only";

import { fetchWithTransientRetry } from "@/modules/llm/providers/fetch-with-transient-retry";
import { embedWithLocalModel, type LocalEmbeddingDtype } from "./local-embedding";

/**
 * Deployment-configured embedding backend for semantic retrieval. Configured by
 * environment (see .env.example), defaulting to "off" so deployments without an
 * embedding model keep today's full-text-search-only behavior:
 *
 * - EMBEDDINGS_PROVIDER: off | local | ollama | openai | gemini
 * - EMBEDDINGS_MODEL:    model name (per-provider default when unset)
 * - EMBEDDINGS_BASE_URL: endpoint override; with provider "openai" this points at
 *                        any OpenAI-compatible server (LM Studio, llama.cpp, vLLM),
 *                        which then needs no cloud key
 * - EMBEDDINGS_API_KEY:  required for gemini, and for openai unless a base URL
 *                        override (local server) is set
 * - EMBEDDINGS_LOCAL_DTYPE: local only — ONNX weight precision, default "q8"
 *                        (quantized ~70MB download); "fp32" for full precision
 *
 * "local" is the zero-setup option: nomic-embed-text runs in-process via
 * transformers.js/ONNX, auto-downloading the model on first use — nothing to
 * install or run beside the app. "ollama" suits hosts that already run a local
 * model server.
 */

export type EmbeddingProviderName = "local" | "ollama" | "openai" | "gemini";

/**
 * Retrieval-oriented embedding models encode documents and queries differently.
 * Backends map this to the model's convention (nomic task prefixes, Gemini
 * taskType); models without the concept ignore it.
 */
export type EmbeddingInputKind = "document" | "query";

export type EmbeddingProvider = {
  name: EmbeddingProviderName;
  model: string;
  /** Stable vector identity persisted per row so provider/model changes trigger re-embedding. */
  vectorReference: string;
  embed(texts: string[], kind?: EmbeddingInputKind): Promise<number[][]>;
};

export type EmbeddingConfig = {
  provider: EmbeddingProviderName | "off";
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  localDtype?: LocalEmbeddingDtype;
};

export const EMBEDDING_DEFAULT_MODELS: Record<EmbeddingProviderName, string> = {
  local: "nomic-ai/nomic-embed-text-v1.5",
  ollama: "nomic-embed-text",
  openai: "text-embedding-3-small",
  gemini: "gemini-embedding-001",
};

const EMBEDDING_DEFAULT_BASE_URLS: Record<Exclude<EmbeddingProviderName, "local">, string> = {
  ollama: "http://127.0.0.1:11434",
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};

const LOCAL_DTYPES: LocalEmbeddingDtype[] = ["q8", "fp16", "fp32", "q4"];
const DEFAULT_LOCAL_DTYPE: LocalEmbeddingDtype = "q8";

// Nomic embedding models require task-specific prefixes for retrieval quality; other
// model families ignore prefixes entirely, so this applies only when the model name
// identifies the nomic family.
const NOMIC_TASK_PREFIXES: Record<EmbeddingInputKind, string> = {
  document: "search_document: ",
  query: "search_query: ",
};

// Bounded so one request cannot exceed provider batch limits (Gemini caps batch
// requests at 100) and a single failure loses at most one batch of work.
const MAX_EMBED_BATCH_SIZE = 64;
// Embedding models have modest context windows; chunks are ~2000 chars, but
// query-side text (a whole requirement) can be much longer.
const MAX_EMBED_INPUT_CHARS = 8000;
const EMBED_RETRY_ATTEMPTS = 2;

export function getEmbeddingConfigFromEnv(env: Record<string, string | undefined> = process.env): EmbeddingConfig {
  const provider = (env.EMBEDDINGS_PROVIDER ?? "off").trim().toLowerCase();
  if (provider !== "local" && provider !== "ollama" && provider !== "openai" && provider !== "gemini") {
    return { provider: "off" };
  }
  const rawDtype = env.EMBEDDINGS_LOCAL_DTYPE?.trim().toLowerCase();
  return {
    provider,
    model: env.EMBEDDINGS_MODEL?.trim() || undefined,
    baseUrl: env.EMBEDDINGS_BASE_URL?.trim() || undefined,
    apiKey: env.EMBEDDINGS_API_KEY?.trim() || undefined,
    localDtype: LOCAL_DTYPES.find((dtype) => dtype === rawDtype),
  };
}

/**
 * Returns the configured embedding provider, or null when embeddings are off or
 * missing a required credential. Callers must treat null as "semantic retrieval
 * unavailable" and continue with full-text search.
 */
export function createEmbeddingProvider(
  config: EmbeddingConfig = getEmbeddingConfigFromEnv(),
): EmbeddingProvider | null {
  if (config.provider === "off") return null;
  // Gemini always needs a key; OpenAI needs one unless pointed at a local
  // OpenAI-compatible server via base URL. local and ollama never need keys.
  if (config.provider === "gemini" && !config.apiKey) return null;
  if (config.provider === "openai" && !config.apiKey && !config.baseUrl) return null;

  const name = config.provider;
  const model = config.model ?? EMBEDDING_DEFAULT_MODELS[name];

  if (name === "local") {
    const dtype = config.localDtype ?? DEFAULT_LOCAL_DTYPE;
    return buildProvider({
      name,
      model,
      // dtype changes the numeric weights, so it is part of the vector identity.
      vectorReference: `local:${model}:${dtype}`,
      embedBatch: (texts) => embedWithLocalModel({ model, dtype, texts }),
    });
  }

  const baseUrl = (config.baseUrl ?? EMBEDDING_DEFAULT_BASE_URLS[name]).replace(/\/+$/, "");
  const apiKey = config.apiKey;
  const embedBatch =
    name === "ollama"
      ? (texts: string[]) => embedWithOllama({ baseUrl, model, texts })
      : name === "openai"
        ? (texts: string[]) => embedWithOpenAi({ baseUrl, model, apiKey, texts })
        : (texts: string[], kind: EmbeddingInputKind) =>
            embedWithGemini({ baseUrl, model, apiKey: apiKey!, texts, kind });

  return buildProvider({ name, model, vectorReference: `${name}:${model}`, embedBatch });
}

function buildProvider(input: {
  name: EmbeddingProviderName;
  model: string;
  vectorReference: string;
  embedBatch: (texts: string[], kind: EmbeddingInputKind) => Promise<number[][]>;
}): EmbeddingProvider {
  return {
    name: input.name,
    model: input.model,
    vectorReference: input.vectorReference,
    embed: (texts, kind = "document") =>
      embedInBatches(applyTaskPrefix(input.model, texts, kind), (batch) => input.embedBatch(batch, kind)),
  };
}

function applyTaskPrefix(model: string, texts: string[], kind: EmbeddingInputKind) {
  if (!/nomic-embed/i.test(model)) return texts;
  const prefix = NOMIC_TASK_PREFIXES[kind];
  return texts.map((text) => prefix + text);
}

async function embedInBatches(
  texts: string[],
  embedBatch: (texts: string[]) => Promise<number[][]>,
): Promise<number[][]> {
  if (!texts.length) return [];
  const prepared = texts.map((text) => text.slice(0, MAX_EMBED_INPUT_CHARS));
  const vectors: number[][] = [];
  for (let start = 0; start < prepared.length; start += MAX_EMBED_BATCH_SIZE) {
    const batch = prepared.slice(start, start + MAX_EMBED_BATCH_SIZE);
    const batchVectors = await embedBatch(batch);
    assertVectorCount(batchVectors, batch.length);
    vectors.push(...batchVectors);
  }
  return vectors;
}

async function embedWithOllama(input: { baseUrl: string; model: string; texts: string[] }) {
  const response = await fetchWithTransientRetry(
    `${input.baseUrl}/api/embed`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: input.model, input: input.texts }),
    },
    EMBED_RETRY_ATTEMPTS,
  );
  if (!response.ok) {
    throw new Error(`Ollama embedding request failed (${response.status}): ${await response.text()}`);
  }
  const json = (await response.json()) as { embeddings?: unknown };
  return parseVectors(json.embeddings, "Ollama");
}

async function embedWithOpenAi(input: { baseUrl: string; model: string; apiKey?: string; texts: string[] }) {
  const response = await fetchWithTransientRetry(
    `${input.baseUrl}/embeddings`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: input.model, input: input.texts }),
    },
    EMBED_RETRY_ATTEMPTS,
  );
  if (!response.ok) {
    throw new Error(`OpenAI-compatible embedding request failed (${response.status}): ${await response.text()}`);
  }
  const json = (await response.json()) as { data?: Array<{ index?: number; embedding?: unknown }> };
  if (!Array.isArray(json.data)) {
    throw new Error("OpenAI-compatible embedding response did not include a data array.");
  }
  const ordered = [...json.data].sort((first, second) => (first.index ?? 0) - (second.index ?? 0));
  return parseVectors(ordered.map((item) => item.embedding), "OpenAI-compatible");
}

async function embedWithGemini(input: {
  baseUrl: string;
  model: string;
  apiKey: string;
  texts: string[];
  kind: EmbeddingInputKind;
}) {
  const response = await fetchWithTransientRetry(
    `${input.baseUrl}/models/${input.model}:batchEmbedContents?key=${input.apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: input.texts.map((text) => ({
          model: `models/${input.model}`,
          content: { parts: [{ text }] },
          taskType: input.kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        })),
      }),
    },
    EMBED_RETRY_ATTEMPTS,
  );
  if (!response.ok) {
    throw new Error(`Gemini embedding request failed (${response.status}): ${await response.text()}`);
  }
  const json = (await response.json()) as { embeddings?: Array<{ values?: unknown }> };
  if (!Array.isArray(json.embeddings)) {
    throw new Error("Gemini embedding response did not include an embeddings array.");
  }
  return parseVectors(json.embeddings.map((item) => item.values), "Gemini");
}

function parseVectors(value: unknown, providerLabel: string): number[][] {
  if (!Array.isArray(value)) {
    throw new Error(`${providerLabel} embedding response did not include vectors.`);
  }
  return value.map((vector) => {
    if (!Array.isArray(vector) || !vector.length || !vector.every((item) => typeof item === "number" && Number.isFinite(item))) {
      throw new Error(`${providerLabel} embedding response contained an invalid vector.`);
    }
    return vector as number[];
  });
}

function assertVectorCount(vectors: number[][], expected: number) {
  if (vectors.length !== expected) {
    throw new Error(`Embedding response returned ${vectors.length} vectors for ${expected} inputs.`);
  }
}
