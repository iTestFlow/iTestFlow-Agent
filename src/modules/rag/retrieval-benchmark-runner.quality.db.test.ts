import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { indexAzureWorkItemsAsProjectContext } from "@/modules/rag/project-context-store.service";
import { syncProjectChunkEmbeddings } from "@/modules/rag/embedding-store.service";
import { createEmbeddingProvider } from "@/modules/rag/embedding-provider";
import {
  labelProjectKnowledgeBenchmarkCase,
  listProjectKnowledgeBenchmarkCases,
  recordProjectKnowledgeBenchmarkQuestion,
} from "@/modules/rag/project-knowledge-benchmark.service";
import { runRetrievalBenchmark } from "@/modules/rag/retrieval-benchmark-runner.service";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

/**
 * Closes the evaluation loop end to end, with the REAL embedding model against a REAL
 * Postgres index: collect a question the way the Business Owner Assistant does, label it
 * the way an admin does from the Knowledge Hub benchmark panel, then confirm the runner
 * scores retrieveContextChatbotEvidence — the actual assistant retrieval path — against
 * that label instead of only the hand-written fixtures in
 * embedding-retrieval.quality.db.test.ts.
 */

const WS = uniqueTestId("ws_retrievalbenchmark");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_retrievalbenchmark");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Retrieval Benchmark Runner",
  azureOrganizationUrl: ORG,
};

const provider = createEmbeddingProvider();

// Reuses the wording/item pairing embedding-retrieval.quality.db.test.ts already proves
// ranks correctly with the real model, so this test's real-model dependency is on
// already-demonstrated behaviour rather than a fresh, unverified pairing.
const ITEMS: Requirement[] = [
  requirement({
    id: "9201",
    azureProjectId: PROJ,
    title: "Expired card handling at checkout",
    description: "The checkout page rejects expired credit cards during payment authorization.",
    acceptanceCriteria: "Given an expired card, when the shopper pays, then show a clear failure reason.",
    tags: [],
  }),
  requirement({
    id: "9202",
    azureProjectId: PROJ,
    title: "Brute force protection",
    description: "Users are locked out for fifteen minutes after five consecutive failed sign-in attempts.",
    acceptanceCriteria: "Given five bad attempts, when another is made, then refuse and start a cooldown.",
    tags: [],
  }),
];

describeDb("retrieval benchmark runner (real model, real index, real labels)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({
      workspaceId: WS,
      orgUrl: ORG,
      azureProjectId: PROJ,
      azureProjectName: scope.azureProjectName,
    });
    await indexAzureWorkItemsAsProjectContext({
      scope,
      actor: "db-test",
      adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => ITEMS) }),
      workItemTypes: ["User Story"],
      states: ["Active"],
      embeddingProvider: null,
    });
    await syncProjectChunkEmbeddings({ scope, provider });

    // Collect two questions the way the Business Owner Assistant chatbot does...
    recordProjectKnowledgeBenchmarkQuestion({
      scope,
      sourceType: "business_owner_assistant",
      question: "why was my card refused when I tried to buy something",
    });
    recordProjectKnowledgeBenchmarkQuestion({
      scope,
      sourceType: "business_owner_assistant",
      question: "account temporarily blocked after too many bad passwords",
    });
    await flushBackgroundWrites();

    // ...then label them the way an admin does from the benchmark panel.
    const collected = await listProjectKnowledgeBenchmarkCases({ scope });
    const cardCase = collected.find((item) => item.question.includes("card refused"));
    const lockoutCase = collected.find((item) => item.question.includes("blocked"));
    if (!cardCase || !lockoutCase) throw new Error("Benchmark questions were not recorded as expected.");

    await labelProjectKnowledgeBenchmarkCase({
      scope,
      caseId: cardCase.id,
      expectedWorkItemId: "9201",
      labeledBy: "db-test-admin",
    });
    await labelProjectKnowledgeBenchmarkCase({
      scope,
      caseId: lockoutCase.id,
      expectedWorkItemId: "9202",
      labeledBy: "db-test-admin",
    });

    // Force one label back into the legacy free-text shape rows could carry before
    // normalization-at-write landed. The service would normalize "AB#9201" today, so
    // write it directly: the runner's normalize-at-compare must still score it.
    await sqlRun(
      `UPDATE project_knowledge_benchmark_cases SET expected_work_item_id = 'AB#9201' WHERE id = @id`,
      { id: cardCase.id },
    );
  }, 300_000);

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM project_knowledge_benchmark_cases WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM embeddings WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @p`, { p: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("scores the real assistant retrieval path against the labeled real-question corpus", async () => {
    const run = await runRetrievalBenchmark({ scope });

    expect(run.caseCount).toBe(2);
    expect(run.results).toHaveLength(2);
    for (const result of run.results) {
      expect(result.rankedWorkItemIds[0]).toBe(result.expectedWorkItemId);
      expect(result.recallAt1).toBe(true);
      expect(result.reciprocalRank).toBe(1);
    }
    expect(run.summary.mrr).toBe(1);
    expect(run.summary.recallAtK[1]).toBe(1);
    // The card case's stored label is the legacy "AB#9201" shape (see beforeAll);
    // the runner must normalize it at compare time and report the canonical id.
    const cardResult = run.results.find((result) => result.question.includes("card refused"));
    expect(cardResult?.expectedWorkItemId).toBe("9201");
  }, 300_000);

  it("excludes unlabeled cases from the run", async () => {
    recordProjectKnowledgeBenchmarkQuestion({
      scope,
      sourceType: "business_owner_assistant",
      question: "how do I export a big report out of the system",
    });
    await flushBackgroundWrites();

    const run = await runRetrievalBenchmark({ scope });
    expect(run.caseCount).toBe(2);
    expect(run.results.some((result) => result.question.includes("export a big report"))).toBe(false);
  }, 300_000);
});
