import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import { syncProjectChunkEmbeddings } from "@/modules/rag/embedding-store.service";
import { searchProjectChunksHybrid } from "@/modules/rag/hybrid-chunk-search";
import { buildFtsQuery } from "@/modules/rag/full-text-search";
import type { EmbeddingProvider } from "@/modules/rag/embedding-provider";
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
  return { name: "ollama", model: "fake-model", vectorReference: "ollama:fake-model", embed };
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
});
