import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import { syncProjectChunkEmbeddings } from "@/modules/rag/embedding-store.service";
import { RERANK_MAX_PAIRS, RERANK_TIMEOUT_MS, searchProjectChunksHybrid } from "@/modules/rag/hybrid-chunk-search";
import { buildFtsQuery } from "@/modules/rag/full-text-search";
import type { EmbeddingProvider } from "@/modules/rag/embedding-provider";
import type { RerankProvider } from "@/modules/rag/rerank-provider";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

const WS = uniqueTestId("ws_hybridsearch");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_hybridsearch");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Hybrid Chunk Search",
  azureOrganizationUrl: ORG,
};

function fakeEmbeddingProvider(embed: EmbeddingProvider["embed"]): EmbeddingProvider {
  return { name: "local", model: "fake-model", vectorReference: "ollama:fake-model", embed };
}

function checkoutItem(): Requirement {
  return requirement({
    id: "601",
    azureProjectId: PROJ,
    title: "Checkout flow",
    description: "The checkout workflow processes payments for the cart.",
    acceptanceCriteria: "Given a cart, when checkout completes, then confirm the order.",
    tags: [],
  });
}

function refundItem(): Requirement {
  return requirement({
    id: "602",
    azureProjectId: PROJ,
    title: "Refund handling",
    description: "Support issues refunds for delivered orders.",
    acceptanceCriteria: "Given a delivered order, when refunded, then notify the customer.",
    tags: [],
  });
}

async function sync(items: Requirement[]) {
  return indexAzureWorkItemsAsProjectContext({
    scope,
    actor: "db-test",
    adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => items) }),
    workItemTypes: ["User Story"],
    states: ["Active"],
    embeddingProvider: null,
  });
}

describeDb("hybrid chunk search (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ, azureProjectName: "Hybrid Chunk Search" });
    await sync([checkoutItem(), refundItem()]);
  });

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM embeddings WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("keeps raw FTS rank ordering when neither semantic nor trigram contribute (embeddings unavailable)", async () => {
    const results = await searchProjectChunksHybrid({
      rerankProvider: null,
      scope,
      ftsQuery: buildFtsQuery("checkout payment"),
      rawQuery: "checkout payment",
      topK: 5,
      embeddingProvider: null,
    });
    expect(results.map(({ row }) => row.azure_work_item_id)).toEqual(["601"]);
    // Raw ts_rank_cd values, not RRF's ~1/(k+rank) scale.
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("fuses FTS, semantic, and trigram results together", async () => {
    // Semantic bridges a paraphrase ("reimbursement" never appears in indexed text);
    // trigram bridges a compound word ("workflow" contains "flow" as an infix, which
    // word-prefix FTS cannot match).
    const provider = fakeEmbeddingProvider(async (texts) =>
      texts.map((text) => (text.toLowerCase().includes("refund") ? [1, 0] : [0, 1])),
    );
    await syncProjectChunkEmbeddings({ scope, provider });

    const results = await searchProjectChunksHybrid({
      rerankProvider: null,
      scope,
      ftsQuery: buildFtsQuery("flow"),
      rawQuery: "flow",
      topK: 5,
      embeddingProvider: provider,
    });

    // "flow" matches "workflow" (checkout) via trigram only -- FTS prefix matching
    // alone would find nothing for this query.
    expect(results.map(({ row }) => row.azure_work_item_id)).toContain("601");
  });

  it("keeps the other sources' results when the semantic source throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = fakeEmbeddingProvider(async () => {
      throw new Error("embedding backend unreachable");
    });

    const results = await searchProjectChunksHybrid({
      rerankProvider: null,
      scope,
      ftsQuery: buildFtsQuery("checkout payment"),
      rawQuery: "checkout payment",
      topK: 5,
      embeddingProvider: failing,
    });

    expect(results.map(({ row }) => row.azure_work_item_id)).toContain("601");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("caps results per work item across the combined sources", async () => {
    const provider = fakeEmbeddingProvider(async (texts) => texts.map(() => [1, 0]));
    await syncProjectChunkEmbeddings({ scope, provider });

    const results = await searchProjectChunksHybrid({
      rerankProvider: null,
      scope,
      ftsQuery: buildFtsQuery("checkout payment"),
      rawQuery: "checkout payment",
      topK: 5,
      maxChunksPerWorkItem: 1,
      embeddingProvider: provider,
    });

    const countsByWorkItem = new Map<string, number>();
    for (const { row } of results) {
      const key = row.azure_work_item_id ?? "";
      countsByWorkItem.set(key, (countsByWorkItem.get(key) ?? 0) + 1);
    }
    expect([...countsByWorkItem.values()].every((count) => count <= 1)).toBe(true);
  });

  it("keeps FTS-only ordering unchanged when rerankProvider is explicitly disabled", async () => {
    // Same fixture and assertions as "keeps raw FTS rank ordering..." above: adding
    // the rerankProvider seam must not change a single byte of behavior when the
    // provider is off, exactly like every other optional signal in this file.
    const results = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery("checkout payment"),
      rawQuery: "checkout payment",
      topK: 5,
      embeddingProvider: null,
      rerankProvider: null,
    });
    expect(results.map(({ row }) => row.azure_work_item_id)).toEqual(["601"]);
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("respects the caller's real topK, not the internal wide rerank pool, when rerankProvider is disabled", async () => {
    // Regression guard for the wide-then-narrow cap: reranking calls
    // applyPerWorkItemCap with a widened topK to build its candidate pool, but a
    // disabled provider must still return only the caller's originally requested
    // topK, not that wider internal size.
    const results = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery("checkout payment"),
      rawQuery: "checkout payment",
      topK: 1,
      embeddingProvider: null,
      rerankProvider: null,
    });
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it("reorders results by rerank score, overriding the fused order", async () => {
    // Every chunk embeds identically, so semantic search alone contributes both
    // work items as equally-similar candidates (601 also via FTS/trigram on
    // "checkout"). Fused order therefore favors 601. A stub reranker that scores
    // the refund passage highest must still win -- proving the pipeline sorts by
    // rerank score rather than just calling the provider and discarding the result.
    const provider = fakeEmbeddingProvider(async (texts) => texts.map(() => [1, 0]));
    await syncProjectChunkEmbeddings({ scope, provider });

    const rerankProvider: RerankProvider = {
      name: "local",
      model: "fake-reranker",
      rerank: async (_query, texts) => texts.map((text) => (text.toLowerCase().includes("refund") ? 1 : 0)),
    };

    const results = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery("checkout payment"),
      rawQuery: "checkout payment",
      topK: 5,
      maxChunksPerWorkItem: 1,
      embeddingProvider: provider,
      rerankProvider,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.row.azure_work_item_id).toBe("602");
  });

  it("falls through to the pre-rerank order when the rerank provider throws", async () => {
    // Same resilience contract as the semantic-source-throws test above: a broken
    // rerank call must not lose results, only skip the reordering step.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingRerankProvider: RerankProvider = {
      name: "local",
      model: "fake-reranker",
      rerank: async () => {
        throw new Error("rerank backend unreachable");
      },
    };

    const results = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery("checkout payment"),
      rawQuery: "checkout payment",
      topK: 5,
      embeddingProvider: null,
      rerankProvider: failingRerankProvider,
    });

    expect(results.map(({ row }) => row.azure_work_item_id)).toEqual(["601"]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("falls back to the fused order when the reranker exceeds its latency budget", async () => {
    // Slowness is degradation, not an error: a rerank slower than RERANK_TIMEOUT_MS
    // must yield the same results a rerank FAILURE yields (the pre-rerank order),
    // within the budget, instead of stalling the search for as long as inference
    // takes. The provider below never resolves, which models a hung ONNX session.
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hungRerankProvider: RerankProvider = {
      name: "local",
      model: "fake-reranker",
      rerank: () => new Promise<number[]>(() => {}),
    };

    const baseline = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery("checkout payment"),
      rawQuery: "checkout payment",
      topK: 5,
      embeddingProvider: null,
      rerankProvider: null,
    });
    const started = performance.now();
    const results = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery("checkout payment"),
      rawQuery: "checkout payment",
      topK: 5,
      embeddingProvider: null,
      rerankProvider: hungRerankProvider,
    });
    const elapsed = performance.now() - started;

    expect(results).toEqual(baseline);
    // Loose bound: the budget plus generous slack for CI variance, but far below
    // "waited for inference" territory.
    expect(elapsed).toBeLessThan(RERANK_TIMEOUT_MS + 3_000);
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("budget"));
    consoleWarn.mockRestore();
  }, 30_000);

  it("scores at most RERANK_MAX_PAIRS candidates and passes the rest through in fused order", async () => {
    // Inference cost is bounded by the pair cap, never result breadth: a large-topK
    // caller (the chatbot fetches 40 candidates) must get its full candidate list
    // back, with only the top fused slice actually run through the cross-encoder.
    // Needs a corpus wider than the cap, so this test seeds its own project.
    const ws = uniqueTestId("ws_rerankcap");
    const proj = uniqueTestId("az_rerankcap");
    const capScope: ProjectScope = {
      projectId: proj,
      azureProjectId: proj,
      azureProjectName: "Rerank Pair Cap",
      azureOrganizationUrl: `https://dev.azure.com/${ws}`,
    };
    await seedWorkspace({ id: ws, orgUrl: capScope.azureOrganizationUrl });
    await seedProject({
      workspaceId: ws,
      orgUrl: capScope.azureOrganizationUrl,
      azureProjectId: proj,
      azureProjectName: capScope.azureProjectName,
    });
    const items = Array.from({ length: 30 }, (_, index) =>
      requirement({
        id: String(700 + index),
        azureProjectId: proj,
        title: `Payment scenario ${index}`,
        description: `Payment case number ${index}: the checkout charges the customer card variant ${index}.`,
        acceptanceCriteria: `Given payment variant ${index}, when checkout runs, then charge succeeds.`,
        tags: [],
      }),
    );
    try {
      await indexAzureWorkItemsAsProjectContext({
        scope: capScope,
        actor: "db-test",
        adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => items) }),
        workItemTypes: ["User Story"],
        states: ["Active"],
        embeddingProvider: null,
      });

      const seenTexts: string[][] = [];
      const recordingRerankProvider: RerankProvider = {
        name: "local",
        model: "fake-reranker",
        rerank: async (_query, texts) => {
          seenTexts.push(texts);
          return texts.map(() => 0.5);
        },
      };

      const results = await searchProjectChunksHybrid({
        scope: capScope,
        ftsQuery: buildFtsQuery("payment checkout"),
        rawQuery: "payment checkout",
        topK: 40,
        embeddingProvider: null,
        rerankProvider: recordingRerankProvider,
      });

      expect(seenTexts).toHaveLength(1);
      expect(seenTexts[0]).toHaveLength(RERANK_MAX_PAIRS);
      // Result breadth is untouched by the cap: every matching work item comes back.
      expect(results.length).toBe(30);
      const returnedIds = new Set(results.map(({ row }) => row.azure_work_item_id));
      expect(returnedIds.size).toBe(30);
    } finally {
      await flushBackgroundWrites();
      for (const table of ["embeddings", "document_chunks_fts", "document_chunks", "azure_devops_work_items", "project_knowledge_log"]) {
        await sqlRun(`DELETE FROM ${table} WHERE project_id = @projectId`, { projectId: proj });
      }
      await cleanupFixtures({ workspaceIds: [ws], userIds: [] });
    }
  }, 60_000);
});
