import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEmbeddingProvider,
  EMBEDDING_DEFAULT_MODELS,
  getEmbeddingConfigFromEnv,
} from "./embedding-provider";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  );
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getEmbeddingConfigFromEnv", () => {
  it("defaults to the zero-setup local backend when unset", () => {
    expect(getEmbeddingConfigFromEnv({})).toMatchObject({ provider: "local" });
    expect(getEmbeddingConfigFromEnv({ EMBEDDINGS_PROVIDER: "" })).toMatchObject({ provider: "local" });
  });

  it("falls back to off for an explicit but unrecognized provider value", () => {
    expect(getEmbeddingConfigFromEnv({ EMBEDDINGS_PROVIDER: "something-else" })).toEqual({
      provider: "off",
    });
  });

  it("disables semantic search when explicitly set to off", () => {
    expect(getEmbeddingConfigFromEnv({ EMBEDDINGS_PROVIDER: "off" })).toEqual({ provider: "off" });
  });

  it("normalizes provider casing and trims values, dropping empties", () => {
    expect(
      getEmbeddingConfigFromEnv({
        EMBEDDINGS_PROVIDER: " Ollama ",
        EMBEDDINGS_MODEL: "  ",
        EMBEDDINGS_BASE_URL: " http://127.0.0.1:11434 ",
        EMBEDDINGS_API_KEY: "",
      }),
    ).toEqual({
      provider: "ollama",
      model: undefined,
      baseUrl: "http://127.0.0.1:11434",
      apiKey: undefined,
      localDtype: undefined,
    });
  });

  it("accepts the local provider and validates its dtype, ignoring unknown values", () => {
    expect(
      getEmbeddingConfigFromEnv({
        EMBEDDINGS_PROVIDER: "local",
        EMBEDDINGS_LOCAL_DTYPE: " FP32 ",
      }),
    ).toMatchObject({ provider: "local", localDtype: "fp32" });
    expect(
      getEmbeddingConfigFromEnv({
        EMBEDDINGS_PROVIDER: "local",
        EMBEDDINGS_LOCAL_DTYPE: "int9",
      }),
    ).toMatchObject({ provider: "local", localDtype: undefined });
  });
});

describe("createEmbeddingProvider", () => {
  it("returns null when off or when a required credential is missing", () => {
    expect(createEmbeddingProvider({ provider: "off" })).toBeNull();
    expect(createEmbeddingProvider({ provider: "gemini" })).toBeNull();
    // Cloud OpenAI needs a key...
    expect(createEmbeddingProvider({ provider: "openai" })).toBeNull();
    // ...but an OpenAI-compatible local server does not.
    expect(
      createEmbeddingProvider({ provider: "openai", baseUrl: "http://127.0.0.1:1234/v1" }),
    ).not.toBeNull();
    // Fully local backends never need keys.
    expect(createEmbeddingProvider({ provider: "ollama" })).not.toBeNull();
    expect(createEmbeddingProvider({ provider: "local" })).not.toBeNull();
  });

  it("applies per-provider default models and records a stable vector reference", () => {
    const provider = createEmbeddingProvider({ provider: "ollama" })!;
    expect(provider.model).toBe(EMBEDDING_DEFAULT_MODELS.ollama);
    expect(provider.vectorReference).toBe(`ollama:${EMBEDDING_DEFAULT_MODELS.ollama}`);

    const custom = createEmbeddingProvider({ provider: "ollama", model: "mxbai-embed-large" })!;
    expect(custom.vectorReference).toBe("ollama:mxbai-embed-large");

    // The in-process backend defaults to quantized weights, and the dtype is part
    // of the vector identity because it changes the numeric output.
    const local = createEmbeddingProvider({ provider: "local" })!;
    expect(local.model).toBe(EMBEDDING_DEFAULT_MODELS.local);
    expect(local.vectorReference).toBe(`local:${EMBEDDING_DEFAULT_MODELS.local}:q8`);
    const fullPrecision = createEmbeddingProvider({ provider: "local", localDtype: "fp32" })!;
    expect(fullPrecision.vectorReference).toBe(`local:${EMBEDDING_DEFAULT_MODELS.local}:fp32`);
  });

  it("calls the local Ollama embed endpoint with nomic task prefixes applied", async () => {
    const vectorsByIndex = [[1, 0], [0, 1], [1, 1]];
    const fetchMock = stubFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return jsonResponse({ embeddings: body.input.map((_, index) => vectorsByIndex[index]) });
    });
    const provider = createEmbeddingProvider({ provider: "ollama" })!;

    await expect(provider.embed(["alpha", "beta"])).resolves.toEqual([[1, 0], [0, 1]]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11434/api/embed");
    // Default kind is "document"; the nomic model family needs task prefixes.
    expect(JSON.parse(String(init!.body))).toEqual({
      model: EMBEDDING_DEFAULT_MODELS.ollama,
      input: ["search_document: alpha", "search_document: beta"],
    });

    await provider.embed(["find it"], "query");
    const queryBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as { input: string[] };
    expect(queryBody.input).toEqual(["search_query: find it"]);
  });

  it("does not prefix non-nomic models", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ embeddings: [[1]] }));
    const provider = createEmbeddingProvider({ provider: "ollama", model: "mxbai-embed-large" })!;
    await provider.embed(["alpha"]);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { input: string[] };
    expect(body.input).toEqual(["alpha"]);
  });

  it("calls OpenAI-compatible servers with a bearer header only when a key exists and reorders by index", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    );
    const local = createEmbeddingProvider({ provider: "openai", baseUrl: "http://127.0.0.1:1234/v1/" })!;
    await expect(local.embed(["alpha", "beta"])).resolves.toEqual([[1, 0], [0, 1]]);

    const [localUrl, localInit] = fetchMock.mock.calls[0]!;
    // Trailing base-URL slash is normalized away.
    expect(localUrl).toBe("http://127.0.0.1:1234/v1/embeddings");
    expect((localInit!.headers as Record<string, string>).Authorization).toBeUndefined();

    const cloud = createEmbeddingProvider({ provider: "openai", apiKey: "sk-test" })!;
    await cloud.embed(["alpha", "beta"]);
    const [cloudUrl, cloudInit] = fetchMock.mock.calls[1]!;
    expect(cloudUrl).toBe("https://api.openai.com/v1/embeddings");
    expect((cloudInit!.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("calls Gemini batch embedding with retrieval task types and parses values", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ embeddings: [{ values: [0.5, 0.5] }] }),
    );
    const provider = createEmbeddingProvider({ provider: "gemini", apiKey: "g-key" })!;

    await expect(provider.embed(["alpha"])).resolves.toEqual([[0.5, 0.5]]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_DEFAULT_MODELS.gemini}:batchEmbedContents?key=g-key`,
    );
    expect(JSON.parse(String(init!.body))).toEqual({
      requests: [
        {
          model: `models/${EMBEDDING_DEFAULT_MODELS.gemini}`,
          content: { parts: [{ text: "alpha" }] },
          taskType: "RETRIEVAL_DOCUMENT",
        },
      ],
    });

    await provider.embed(["alpha"], "query");
    const queryBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body)) as {
      requests: Array<{ taskType: string }>;
    };
    expect(queryBody.requests[0]!.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("splits large inputs into bounded batches and truncates oversized texts", async () => {
    const fetchMock = stubFetch(async (_url, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[] };
      return jsonResponse({ embeddings: body.input.map(() => [1]) });
    });
    const provider = createEmbeddingProvider({ provider: "ollama" })!;

    const vectors = await provider.embed(
      Array.from({ length: 70 }, (_, index) => (index === 0 ? "y".repeat(10000) : `text ${index}`)),
    );

    expect(vectors).toHaveLength(70);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBatch = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as { input: string[] };
    expect(firstBatch.input).toHaveLength(64);
    // Truncation happens after prefixing, so the cap holds and the prefix survives.
    expect(firstBatch.input[0]).toHaveLength(8000);
    expect(firstBatch.input[0]!.startsWith("search_document: ")).toBe(true);

    await expect(provider.embed([])).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on error statuses, malformed vectors, and count mismatches", async () => {
    stubFetch(() => new Response("model not found", { status: 404 }));
    const provider = createEmbeddingProvider({ provider: "ollama" })!;
    await expect(provider.embed(["alpha"])).rejects.toThrow("model not found");

    stubFetch(() => jsonResponse({ embeddings: [["not-a-number"]] }));
    await expect(provider.embed(["alpha"])).rejects.toThrow("invalid vector");

    stubFetch(() => jsonResponse({ embeddings: [[1, 2]] }));
    await expect(provider.embed(["alpha", "beta"])).rejects.toThrow("2 inputs");
  });
});
