import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  rerank: vi.fn(),
}));

vi.mock("@/modules/rag/embedding-provider", () => ({
  createEmbeddingProvider: () => ({
    name: "local",
    model: "stub",
    vectorReference: "stub",
    embed: mocks.embed,
  }),
}));
vi.mock("@/modules/rag/rerank-provider", () => ({
  createRerankProvider: () => ({
    name: "local",
    model: "stub",
    rerank: mocks.rerank,
  }),
}));

import { warmLocalModels } from "@/modules/rag/local-model-warmup";

describe("warmLocalModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.embed.mockResolvedValue([[0, 1]]);
    mocks.rerank.mockResolvedValue([0.5]);
  });

  it("warms both models", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    await warmLocalModels();

    expect(mocks.embed).toHaveBeenCalledTimes(1);
    expect(mocks.rerank).toHaveBeenCalledTimes(1);
    expect(consoleLog).toHaveBeenCalledTimes(2);
    consoleLog.mockRestore();
  });

  it("still warms the reranker and resolves when the embedding warm-up fails", async () => {
    // The fire-and-forget contract: a failed warm-up must cost nothing beyond the
    // first real call paying the load itself - never a rejected promise at boot.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.embed.mockRejectedValue(new Error("offline"));

    await expect(warmLocalModels()).resolves.toBeUndefined();

    expect(mocks.rerank).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("embedding model"), expect.any(Error));
    consoleWarn.mockRestore();
  });

  it("resolves when both warm-ups fail", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.embed.mockRejectedValue(new Error("offline"));
    mocks.rerank.mockRejectedValue(new Error("offline"));

    await expect(warmLocalModels()).resolves.toBeUndefined();
    expect(consoleWarn).toHaveBeenCalledTimes(2);
    consoleWarn.mockRestore();
  });
});
