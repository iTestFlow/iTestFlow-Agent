import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlAll, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  refreshProjectKnowledgeSearchIndex,
} from "@/modules/rag/context-chatbot-retrieval.service";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import {
  searchProjectKnowledgeByEmbedding,
  syncProjectChunkEmbeddings,
  syncProjectKnowledgeEntryEmbeddings,
} from "@/modules/rag/embedding-store.service";
import { ProjectKnowledgeBaseSchema, type ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import type { EmbeddingProvider } from "@/modules/rag/embedding-provider";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

const WS = uniqueTestId("ws_kbembed");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_kbembed");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Knowledge Embedding",
  azureOrganizationUrl: ORG,
};

function fakeEmbeddingProvider(model = "fake-model"): EmbeddingProvider {
  return {
    name: "ollama",
    model,
    vectorReference: `ollama:${model}`,
    embed: async (texts) => texts.map(() => [1, 0, 0]),
  };
}

function knowledgeBaseWithModule(): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [{
      id: "checkout-module",
      name: "Checkout",
      description: "Handles cart checkout and payment capture.",
      sourceWorkItemIds: ["901"],
      evidence: "WI 901",
    }],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
  });
}

function knowledgeBaseWithoutModule(): ProjectKnowledgeBase {
  return ProjectKnowledgeBaseSchema.parse({
    modules: [],
    businessRules: [],
    stateTransitions: [],
    glossary: [],
    crossDependencies: [],
  });
}

async function knowledgeEmbeddingRows() {
  return sqlAll<{ chunk_id: string; source_type: string }>(
    `SELECT chunk_id, source_type FROM embeddings WHERE project_id = @projectId AND source_type = 'project_knowledge_entry' ORDER BY chunk_id`,
    { projectId: PROJ },
  );
}

async function allEmbeddingRows() {
  return sqlAll<{ chunk_id: string; source_type: string }>(
    `SELECT chunk_id, source_type FROM embeddings WHERE project_id = @projectId ORDER BY source_type, chunk_id`,
    { projectId: PROJ },
  );
}

describeDb("knowledge entry embeddings (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ, azureProjectName: "Knowledge Embedding" });
  });

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM embeddings WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_entries_fts WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_entries WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("embeds every current entry and re-embeds in place across saves, despite the entry table's id churning every save", async () => {
    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: knowledgeBaseWithModule(),
    });
    const provider = fakeEmbeddingProvider();
    const first = await syncProjectKnowledgeEntryEmbeddings({ scope, provider });
    expect(first).toEqual({ embeddedEntryCount: 1, removedEmbeddingCount: 0 });

    const afterFirst = await knowledgeEmbeddingRows();
    expect(afterFirst).toHaveLength(1);
    const chunkId = afterFirst[0]!.chunk_id;
    expect(chunkId).toBe(`kb:${PROJ}:module:checkout-module`);

    // refreshProjectKnowledgeSearchIndex fully deletes+reinserts project_knowledge_entries
    // with a fresh random id every call, even for identical content -- the embedding
    // row must stay keyed on the stable synthetic id, not the churning table id.
    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: knowledgeBaseWithModule(),
    });
    const second = await syncProjectKnowledgeEntryEmbeddings({ scope, provider });
    expect(second.removedEmbeddingCount).toBe(0);

    const afterSecond = await knowledgeEmbeddingRows();
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0]!.chunk_id).toBe(chunkId);
  });

  it("removes embeddings for entries no longer present after a save drops them", async () => {
    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: knowledgeBaseWithoutModule(),
    });
    const result = await syncProjectKnowledgeEntryEmbeddings({ scope, provider: fakeEmbeddingProvider() });
    expect(result).toEqual({ embeddedEntryCount: 0, removedEmbeddingCount: 1 });
    expect(await knowledgeEmbeddingRows()).toEqual([]);
  });

  it("does not cross-contaminate with chunk embeddings in the same project", async () => {
    await refreshProjectKnowledgeSearchIndex({
      scope,
      knowledgeBaseId: uniqueTestId("pkb"),
      knowledgeBase: knowledgeBaseWithModule(),
    });
    const provider = fakeEmbeddingProvider();
    await syncProjectKnowledgeEntryEmbeddings({ scope, provider });

    const workItem: Requirement = requirement({
      id: "902",
      azureProjectId: PROJ,
      title: "Payment retry",
      description: "Retries a failed payment automatically.",
      acceptanceCriteria: "Given a failed payment, when retried, then succeed or notify.",
      tags: [],
    });
    await indexAzureWorkItemsAsProjectContext({
      scope,
      actor: "db-test",
      adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => [workItem]) }),
      workItemTypes: ["User Story"],
      states: ["Active"],
    });
    await syncProjectChunkEmbeddings({ scope, provider });

    const rows = await allEmbeddingRows();
    expect(rows.filter((row) => row.source_type === "project_knowledge_entry")).toHaveLength(1);
    expect(rows.filter((row) => row.source_type === "azure_work_item_chunk")).toHaveLength(1);

    // Re-running each pipeline's own sync must not delete the other's row.
    await syncProjectKnowledgeEntryEmbeddings({ scope, provider });
    await syncProjectChunkEmbeddings({ scope, provider });
    const rowsAfter = await allEmbeddingRows();
    expect(rowsAfter).toHaveLength(2);
  });

  it("ranks knowledge semantic search by cosine similarity and scopes to the vector reference", async () => {
    const provider: EmbeddingProvider = {
      name: "ollama",
      model: "ranked-model",
      vectorReference: "ollama:ranked-model",
      embed: async (texts) => texts.map((text) => (text.toLowerCase().includes("checkout") ? [1, 0] : [0, 1])),
    };
    await syncProjectKnowledgeEntryEmbeddings({ scope, provider });

    const results = await searchProjectKnowledgeByEmbedding({ scope, provider, query: "checkout", topK: 5 });
    expect(results.map((row) => row.entry_key)).toContain("checkout-module");
    expect(results[0]!.similarity).toBeGreaterThan(0);

    const otherReference = await searchProjectKnowledgeByEmbedding({
      scope,
      provider: fakeEmbeddingProvider("unseen-model"),
      query: "checkout",
      topK: 5,
    });
    expect(otherReference).toEqual([]);
  });
});
