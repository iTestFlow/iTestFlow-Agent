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
  chunkVectorReference,
  searchProjectContextByEmbedding,
  syncProjectChunkEmbeddings,
} from "@/modules/rag/embedding-store.service";
import { MAX_EMBED_BATCH_SIZE, type EmbeddingProvider } from "@/modules/rag/embedding-provider";
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
    name: "local",
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
    embeddingProvider: null,
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
    // Each item has both a description and acceptance criteria, so field-aware
    // chunking produces two chunks per item (a core unit and an acceptance_criteria
    // unit) -- 4 chunks across the two items, not 2.
    await sync([paymentItem(), telemetryItem()]);
    const provider = fakeEmbeddingProvider();

    const first = await syncProjectChunkEmbeddings({ scope, provider });
    expect(first).toEqual({ embeddedChunkCount: 4, removedEmbeddingCount: 0 });

    const second = await syncProjectChunkEmbeddings({ scope, provider });
    expect(second).toEqual({ embeddedChunkCount: 0, removedEmbeddingCount: 0 });

    const rows = await embeddingRows();
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.vector_reference === chunkVectorReference(provider))).toBe(true);
  });

  it("re-embeds in place when the configured model changes, without duplicating rows", async () => {
    const otherProvider = fakeEmbeddingProvider("other-model");
    const swapped = await syncProjectChunkEmbeddings({ scope, provider: otherProvider });
    expect(swapped).toEqual({ embeddedChunkCount: 4, removedEmbeddingCount: 0 });

    const rows = await embeddingRows();
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.vector_reference === chunkVectorReference(otherProvider))).toBe(true);
  });

  it("removes embeddings whose chunks were deleted by a rebuild, and re-embeds surviving ones", async () => {
    // Rebuild with only the telemetry item: the payment item's two chunks disappear,
    // and their embedding rows must go with them. Rebuild unconditionally deletes and
    // reinserts every chunk (even byte-identical content), which bumps
    // document_chunks.updated_at for the surviving telemetry chunks too -- so their
    // pre-rebuild embeddings are now stale by the staleness check and legitimately
    // get re-embedded. This is an accepted cost of an explicit full rebuild, not a bug.
    await sync([telemetryItem()], "rebuild");
    const result = await syncProjectChunkEmbeddings({ scope, provider: fakeEmbeddingProvider("other-model") });

    expect(result).toEqual({ embeddedChunkCount: 2, removedEmbeddingCount: 2 });
    const rows = await embeddingRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.chunk_id.includes("_202_"))).toBe(true);
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
      rerankProvider: null,
      scope,
      query: "charge settlement",
      embeddingProvider: null,
      sourceKinds: ["azure_work_item"],
    });
    expect(lexicalOnly).toEqual([]);

    // Hybrid: the semantic list bridges the paraphrase and the payment item wins.
    const hybrid = await retrieveStoredProjectContext({
      rerankProvider: null,
      scope,
      query: "charge settlement",
      embeddingProvider: provider,
      sourceKinds: ["azure_work_item"],
    });
    expect(hybrid[0]?.workItemId).toBe("201");
    expect(hybrid[0]?.relevanceScore).toBe(1);

    // When both retrievers agree, fusion keeps the agreed item on top with 0..1 scores.
    const agreed = await retrieveStoredProjectContext({
      rerankProvider: null,
      scope,
      query: "telemetry devices",
      embeddingProvider: provider,
      sourceKinds: ["azure_work_item"],
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
      name: "local",
      model: "other-model",
      vectorReference: "ollama:other-model",
      embed: async () => {
        throw new Error("embedding backend unreachable");
      },
    };

    const sources = await retrieveStoredProjectContext({
      rerankProvider: null,
      scope,
      query: "telemetry devices",
      embeddingProvider: failing,
      sourceKinds: ["azure_work_item"],
    });
    expect(sources[0]?.workItemId).toBe("202");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("re-embeds a chunk whose content changed without the chunk count changing", async () => {
    // A single short item -> exactly one chunk, so an edit keeps the same
    // deterministic chunk id. Regression for staleness: existence-only pending
    // checks would never re-embed this, silently keeping the pre-edit vector.
    const editableItem = (description: string) =>
      requirement({
        id: "301",
        azureProjectId: PROJ,
        title: "Editable item",
        description,
        acceptanceCriteria: "Given a case, when it changes, then re-embed.",
        tags: [],
      });
    await sync([editableItem("Initial payment description.")]);
    const provider = fakeEmbeddingProvider("staleness-model");
    const first = await syncProjectChunkEmbeddings({ scope, provider });
    expect(first.embeddedChunkCount).toBeGreaterThanOrEqual(1);

    const beforeRow = (await embeddingRows()).find((row) => row.chunk_id.includes("_301_"));
    const beforeVector = await sqlAll<{ vector: number[] }>(
      `SELECT vector FROM embeddings WHERE chunk_id = @chunkId`,
      { chunkId: beforeRow!.chunk_id },
    );

    // Same chunk count (still one short chunk), different content -> same chunk id,
    // fresh document_chunks.updated_at.
    await sync([editableItem("Now this talks about telemetry devices instead.")]);
    const second = await syncProjectChunkEmbeddings({ scope, provider });
    expect(second.embeddedChunkCount).toBeGreaterThanOrEqual(1);

    const afterVector = await sqlAll<{ vector: number[] }>(
      `SELECT vector FROM embeddings WHERE chunk_id = @chunkId`,
      { chunkId: beforeRow!.chunk_id },
    );
    expect(afterVector[0]!.vector).not.toEqual(beforeVector[0]!.vector);
  });

  it("persists already-embedded batches when a later batch's embedding call fails", async () => {
    // Enough active chunks to force at least two provider.embed() calls, so a
    // failure on the second batch is distinguishable from the first.
    const items = Array.from({ length: MAX_EMBED_BATCH_SIZE + 1 }, (_, index) =>
      requirement({
        id: `4${String(index).padStart(3, "0")}`,
        azureProjectId: PROJ,
        title: `Batch item ${index}`,
        description: `Batch content ${index}.`,
        acceptanceCriteria: "Given a batch, when embedded, then persist.",
        tags: [],
      }),
    );
    await sync(items, "rebuild");

    let call = 0;
    const failingOnSecondBatch: EmbeddingProvider = {
      name: "local",
      model: "batch-fail-model",
      vectorReference: "ollama:batch-fail-model",
      embed: async (texts) => {
        call += 1;
        if (call === 2) throw new Error("simulated transient failure on batch 2");
        return texts.map(() => [1, 0, 0]);
      },
    };

    await expect(
      syncProjectChunkEmbeddings({ scope, provider: failingOnSecondBatch }),
    ).rejects.toThrow("simulated transient failure on batch 2");

    const persisted = await sqlAll<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM embeddings WHERE project_id = @projectId AND vector_reference = @vectorReference`,
      { projectId: PROJ, vectorReference: chunkVectorReference(failingOnSecondBatch) },
    );
    // The first batch's chunks were persisted before the second batch's failure;
    // without the fix this would be 0 (the whole call's work discarded).
    expect(persisted[0]!.count).toBe(MAX_EMBED_BATCH_SIZE);
    expect(persisted[0]!.count).toBeLessThan(items.length);
  });
  it("prefixes every chunk's embedded text with its work item title", async () => {
    // Chunking splits one work item's composed text, so only the FIRST chunk contains
    // the "Title: ..." line — continuation chunks are anonymous fragments. Both
    // lexical signals already index `title || content` for every row
    // (document_chunks_fts.tsv and the trigram index), so embedding content alone left
    // semantic search as the only signal blind to the title on continuation chunks.
    //
    // Asserted on the text handed to the model, because the end-to-end effect is not
    // separable: chunk 0 carries the title in its body anyway, so the work item is
    // still found either way — what changes is which CHUNK ranks best.
    const longBody = Array.from(
      { length: 40 },
      (_, index) =>
        `Step ${index}: the operator scans each shelf label, confirms the counted quantity against the recorded figure, and records any discrepancy with a reason code.`,
    ).join(" ");
    await sync([
      requirement({
        id: "770",
        azureProjectId: PROJ,
        title: "Warehouse stocktake reconciliation",
        description: longBody,
        acceptanceCriteria: "Given a completed count, when discrepancies exist, then require approval.",
        tags: [],
      }),
    ]);

    const embedded: string[] = [];
    const recording: EmbeddingProvider = {
      name: "local",
      model: "title-prefix-model",
      vectorReference: "ollama:title-prefix-model",
      embed: async (texts) => {
        embedded.push(...texts);
        return texts.map(() => [1, 0, 0]);
      },
    };
    await syncProjectChunkEmbeddings({ scope, provider: recording });

    const chunksFor770 = embedded.filter((text) => text.includes("shelf label"));
    // The body is long enough to split, so this only proves anything with >1 chunk.
    expect(chunksFor770.length).toBeGreaterThan(1);
    // EVERY chunk carries the title, including the continuation chunks whose bodies
    // contain none of the title's words.
    for (const text of chunksFor770) {
      expect(text.startsWith("Warehouse stocktake reconciliation")).toBe(true);
    }
  });
});
