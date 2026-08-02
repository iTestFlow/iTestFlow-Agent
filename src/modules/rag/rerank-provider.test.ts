import { beforeEach, describe, expect, it, vi } from "vitest";

const local = vi.hoisted(() => ({ rerankWithLocalModel: vi.fn() }));
vi.mock("./local-rerank", () => local);

import { createRerankProvider, MAX_RERANK_BATCH_SIZE, MAX_RERANK_QUERY_CHARS, RERANK_DTYPE, RERANK_MODEL } from "./rerank-provider";

/**
 * Unit coverage for the provider's own logic — batching, truncation and validation —
 * with the ONNX model mocked out. Real cross-encoder inference is proven separately
 * (see rerank-retrieval.quality.db.test.ts): this file never loads the ~23 MB weights.
 */

/** Returns one score per input so the count assertion passes by default. */
function respondWithOneScorePerInput() {
  local.rerankWithLocalModel.mockImplementation(async ({ texts }: { texts: string[] }) =>
    texts.map((_, index) => index / 10),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  respondWithOneScorePerInput();
});

describe("createRerankProvider", () => {
  it("pins one local cross-encoder, with nothing for a deployment to change", () => {
    const provider = createRerankProvider();

    expect(provider.name).toBe("local");
    expect(provider.model).toBe(RERANK_MODEL);
  });

  it("passes the pinned model and dtype through to the runtime", async () => {
    await createRerankProvider().rerank("query", ["alpha"]);

    expect(local.rerankWithLocalModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: RERANK_MODEL, dtype: RERANK_DTYPE, query: "query", texts: ["alpha"] }),
    );
  });

  it("scores align 1:1 with the input texts, in order", async () => {
    const scores = await createRerankProvider().rerank("query", ["a", "b", "c"]);

    expect(scores).toEqual([0, 0.1, 0.2]);
  });

  it("splits large candidate pools into bounded batches and preserves order", async () => {
    const inputCount = MAX_RERANK_BATCH_SIZE * 2 + 3;
    local.rerankWithLocalModel.mockImplementation(async ({ texts }: { texts: string[] }) =>
      texts.map((text) => Number(text.replace("item", ""))),
    );

    const scores = await createRerankProvider().rerank(
      "query",
      Array.from({ length: inputCount }, (_, index) => `item${index}`),
    );

    expect(scores).toHaveLength(inputCount);
    expect(local.rerankWithLocalModel).toHaveBeenCalledTimes(3);
    expect(local.rerankWithLocalModel.mock.calls[0]![0].texts).toHaveLength(MAX_RERANK_BATCH_SIZE);
    expect(local.rerankWithLocalModel.mock.calls[2]![0].texts).toHaveLength(3);
    // Batching must not reorder: score N still belongs to input N.
    expect(scores[0]).toBe(0);
    expect(scores[inputCount - 1]).toBe(inputCount - 1);
  });

  it("reuses the same query text across every batch of a multi-batch call", async () => {
    const inputCount = MAX_RERANK_BATCH_SIZE + 1;
    await createRerankProvider().rerank(
      "checkout payment failure",
      Array.from({ length: inputCount }, (_, index) => `item${index}`),
    );

    expect(local.rerankWithLocalModel).toHaveBeenCalledTimes(2);
    for (const call of local.rerankWithLocalModel.mock.calls) {
      expect(call[0].query).toBe("checkout payment failure");
    }
  });

  it("truncates oversized text and query input, with a tighter cap on the query", async () => {
    // The 512-token pair window is shared and nothing prioritizes the passage, so the
    // query must not be allowed to consume it — see MAX_RERANK_QUERY_CHARS.
    await createRerankProvider().rerank("q".repeat(5000), ["p".repeat(5000)]);

    const call = local.rerankWithLocalModel.mock.calls[0]![0];
    expect(call.query).toHaveLength(MAX_RERANK_QUERY_CHARS);
    expect(call.texts[0]).toHaveLength(2000);
  });

  it("returns an empty result without invoking the model", async () => {
    await expect(createRerankProvider().rerank("query", [])).resolves.toEqual([]);
    expect(local.rerankWithLocalModel).not.toHaveBeenCalled();
  });

  it("throws when the runtime returns the wrong number of scores", async () => {
    // Guards against a silent misalignment that would attach the wrong relevance
    // score to a candidate, corrupting the sort in hybrid-chunk-search.ts.
    local.rerankWithLocalModel.mockResolvedValue([0.5]);

    await expect(createRerankProvider().rerank("query", ["alpha", "beta"])).rejects.toThrow(
      "returned 1 scores for 2 inputs",
    );
  });

  it("propagates a model failure so callers can degrade to the pre-rerank order", async () => {
    local.rerankWithLocalModel.mockRejectedValue(new Error("model download failed"));

    await expect(createRerankProvider().rerank("query", ["alpha"])).rejects.toThrow("model download failed");
  });
});
