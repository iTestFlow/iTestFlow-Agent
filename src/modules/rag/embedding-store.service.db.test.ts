import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  flushBackgroundWrites,
  resetDatabaseForTests,
  sqlAll,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import {
  indexAzureWorkItemsAsProjectContext,
  retrieveStoredProjectContext,
} from "@/modules/rag/project-context-store.service";
import {
  searchProjectContextByEmbedding,
  syncProjectChunkEmbeddings,
} from "@/modules/rag/embedding-store.service";
import type { EmbeddingProvider } from "@/modules/rag/embedding-provider";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

const WS = uniqueTestId("ws_embstore");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_embstore");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Embedding Store",
  azureOrganizationUrl: ORG,
};

// Deterministic 3-dim "embeddings": two topic dimensions plus a constant so no
// vector is zero-norm. "charge"/"settlement" share the payment dimension, which is
// exactly the paraphrase bridging lexical search cannot do.
const TOPIC_DIMENSIONS: Record<string, number> = {
  payment: 0,
  charge: 0,
  settlement: 0,
  telemetry: 1,
  devices: 1,
};

function textToVector(text: string): number[] {
  const lower = text.toLowerCase();
  const vector = [0.01, 0.01, 1];
  for (const [word, dimension] of Object.entries(TOPIC_DIMENSIONS)) {
    vector[dimension] += lower.split(word).length - 1;
  }
  return vector;
}

function fakeEmbeddingProvider(model = "fake-model"): EmbeddingProvider {
  return {
    name: "ollama",
    model,
    vectorReference: `ollama:${model}`,
    embed: async (texts) => texts.map(textToVector),
  };
}

function paymentItem(): Requirement {
  return requirement({
    id: "201",
    azureProjectId: PROJ,
    title: "Card payment flow",
    description: "Customer pays by card during checkout payment.",
    acceptanceCriteria: "Given a cart, when payment succeeds, then show confirmation.",
    tags: [],
  });
}

function telemetryItem(): Requirement {
  return requirement({
    id: "202",
    azureProjectId: PROJ,
    title: "Telemetry pipeline",
    description: "Ingest telemetry events from devices.",
    acceptanceCriteria: "Given devices, when telemetry arrives, then store it.",
    tags: [],
  });
}

async function sync(items: Requirement[], mode?: "incremental" | "rebuild") {
  return indexAzureWorkItemsAsProjectContext({
    scope,
    actor: "db-test",
    adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => items) }),
    workItemTypes: ["User Story"],
    states: ["Active"],
    mode,
  });
}

async function embeddingRows() {
  return sqlAll<{ chunk_id: string; vector_reference: string }>(
    `SELECT chunk_id, vector_reference FROM embeddings WHERE project_id = @projectId ORDER BY chunk_id`,
    { projectId: PROJ },
  );
}

describeDb("embedding store and hybrid retrieval (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ, azureProjectName: "Embedding Store" });
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

  it("embeds every active chunk once and is idempotent on re-run", async () => {
    await sync([paymentItem(), telemetryItem()]);
    const provider = fakeEmbeddingProvider();

    const first = await syncProjectChunkEmbeddings({ scope, provider });
    expect(first).toEqual({ embeddedChunkCount: 2, removedEmbeddingCount: 0 });

    const second = await syncProjectChunkEmbeddings({ scope, provider });
    expect(second).toEqual({ embeddedChunkCount: 0, removedEmbeddingCount: 0 });

    const rows = await embeddingRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.vector_reference === "ollama:fake-model")).toBe(true);
  });

  it("re-embeds in place when the configured model changes, without duplicating rows", async () => {
    const swapped = await syncProjectChunkEmbeddings({ scope, provider: fakeEmbeddingProvider("other-model") });
    expect(swapped).toEqual({ embeddedChunkCount: 2, removedEmbeddingCount: 0 });

    const rows = await embeddingRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.vector_reference === "ollama:other-model")).toBe(true);
  });

  it("removes embeddings whose chunks were deleted by a rebuild", async () => {
    // Rebuild with only the telemetry item: the payment chunk disappears, and its
    // embedding row must go with it. The surviving chunk keeps its deterministic id,
    // so its still-current vector is not re-embedded.
    await sync([telemetryItem()], "rebuild");
    const result = await syncProjectChunkEmbeddings({ scope, provider: fakeEmbeddingProvider("other-model") });

    expect(result).toEqual({ embeddedChunkCount: 0, removedEmbeddingCount: 1 });
    const rows = await embeddingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.chunk_id).toContain("_202_");
  });

  it("ranks semantic search by cosine similarity and scopes vectors to the provider reference", async () => {
    await sync([paymentItem(), telemetryItem()]);
    const provider = fakeEmbeddingProvider("other-model");
    await syncProjectChunkEmbeddings({ scope, provider });

    // "charge settlement" shares no words with the payment chunk, but the fake
    // vectors place them on the same topic dimension.
    const results = await searchProjectContextByEmbedding({
      scope,
      provider,
      query: "charge settlement",
      topK: 5,
    });
    expect(results[0]?.azure_work_item_id).toBe("201");
    expect(results[0]!.similarity).toBeGreaterThan(results[1]?.similarity ?? 0);

    // A provider whose vector reference has no stored vectors finds nothing.
    const otherReference = await searchProjectContextByEmbedding({
      scope,
      provider: fakeEmbeddingProvider("unseen-model"),
      query: "charge settlement",
      topK: 5,
    });
    expect(otherReference).toEqual([]);
  });

  it("surfaces paraphrase matches through hybrid retrieval that lexical-only misses", async () => {
    const provider = fakeEmbeddingProvider("other-model");

    // Lexical-only: no chunk contains "charge" or "settlement".
    const lexicalOnly = await retrieveStoredProjectContext({
      scope,
      query: "charge settlement",
      embeddingProvider: null,
    });
    expect(lexicalOnly).toEqual([]);

    // Hybrid: the semantic list bridges the paraphrase and the payment item wins.
    const hybrid = await retrieveStoredProjectContext({
      scope,
      query: "charge settlement",
      embeddingProvider: provider,
    });
    expect(hybrid[0]?.workItemId).toBe("201");
    expect(hybrid[0]?.relevanceScore).toBe(1);

    // When both retrievers agree, fusion keeps the agreed item on top with 0..1 scores.
    const agreed = await retrieveStoredProjectContext({
      scope,
      query: "telemetry devices",
      embeddingProvider: provider,
    });
    expect(agreed[0]?.workItemId).toBe("202");
    for (const source of agreed) {
      expect(source.relevanceScore).toBeGreaterThan(0);
      expect(source.relevanceScore).toBeLessThanOrEqual(1);
    }
  });

  it("degrades to lexical results when the embedding backend fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing: EmbeddingProvider = {
      name: "ollama",
      model: "other-model",
      vectorReference: "ollama:other-model",
      embed: async () => {
        throw new Error("embedding backend unreachable");
      },
    };

    const sources = await retrieveStoredProjectContext({
      scope,
      query: "telemetry devices",
      embeddingProvider: failing,
    });
    expect(sources[0]?.workItemId).toBe("202");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
