import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { flushBackgroundWrites, resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  indexAzureWorkItemsAsProjectContext,
  requirementToRetrievalQuery,
  workItemToContextUnits,
} from "@/modules/rag/project-context-store.service";
import { syncProjectChunkEmbeddings } from "@/modules/rag/embedding-store.service";
import { searchProjectChunksHybrid } from "@/modules/rag/hybrid-chunk-search";
import { buildFtsQuery } from "@/modules/rag/full-text-search";
import { createEmbeddingProvider } from "@/modules/rag/embedding-provider";
import { createRerankProvider } from "@/modules/rag/rerank-provider";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

/**
 * End-to-end proof that the local cross-encoder reranker (Xenova/ms-marco-MiniLM-L-6-v2)
 * earns its place, running the REAL model against a REAL Postgres index -- same spirit
 * as embedding-retrieval.quality.db.test.ts, for the rerank stage.
 *
 * The corpus is a lexical trap: WRONG's chunk text repeats the query's own words MORE
 * than RIGHT's does, yet WRONG answers a different question ("how do I configure CI
 * environment variables") than the one asked. A pure term-frequency signal has no way
 * to see that difference; a cross-encoder reading the query and passage together does.
 *
 * Measured against the real model and a real index: the reranker scores RIGHT's passage
 * 0.999 against WRONG's 0.591, and warm inference over a handful of pairs costs ~2ms.
 * Fusion alone also ranks RIGHT first here (see the last test) -- so what this file
 * proves is that the reranker's own judgement is sound and that adding it does not
 * disturb an already-correct order, NOT that it rescues a broken one.
 */

const WS = uniqueTestId("ws_rerankquality");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_rerankquality");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Rerank Retrieval Quality",
  azureOrganizationUrl: ORG,
};

const embeddingProvider = createEmbeddingProvider();
const rerankProvider = createRerankProvider();

const QUERY = "how do I export my test run results";
const RIGHT_ID = "9101";
const WRONG_ID = "9102";

const rightItem = requirement({
  id: RIGHT_ID,
  azureProjectId: PROJ,
  title: "Export test run results",
  description:
    "Users can export their finished test run results as a CSV file from the results page for offline analysis and sharing with stakeholders.",
  acceptanceCriteria:
    "Given a completed test run, when the user exports results, then a CSV file with all test run results is produced.",
  tags: [],
});

const wrongItem = requirement({
  id: WRONG_ID,
  azureProjectId: PROJ,
  title: "Export CI environment variables",
  // Deliberately denser in the query's own words than the item above (measured:
  // export/test/run/results appear 21 times total here vs 16 above) -- a passage
  // about a different feature that a term-frequency signal cannot tell apart from a
  // genuine answer.
  description:
    "Before an automated test run starts, the CI pipeline exports environment variables such as API keys so the test runner can authenticate against external services and produce test results. This export applies to every test run in the pipeline configuration.",
  acceptanceCriteria:
    "Given a CI pipeline configuration, when a test run begins, then required environment variables are exported first, before any test results exist. Test run results are generated separately after each test run completes.",
  tags: [],
});

const ITEMS: Requirement[] = [rightItem, wrongItem];

// Workflow auto-context does not rerank with a short question: it passes
// requirementToRetrievalQuery(targetRequirement) — title, description, acceptance
// criteria and tags joined, unbounded. Built with the same production function so the
// fixture is provably the real query shape. The genuine ask sits in the title and the
// opening description sentences (where real requirements put it); the rest is the
// boilerplate tail real work items carry. Length is guarded below so the fixture cannot
// silently shrink out of the regime it exists to exercise.
const longRequirement = requirement({
  id: "9103",
  azureProjectId: PROJ,
  title: "Export test run results from the results page",
  description: [
    "As a QA lead, I want to export my finished test run results as a CSV file from the results page, so I can analyse them offline and share them with stakeholders who do not have access to the tool.",
    "Background: our compliance team reviews release evidence quarterly and requires result artifacts to be archived alongside the release record in the document management system. Today testers copy results into spreadsheets by hand, which is slow and error-prone and has twice produced divergent numbers between the archived spreadsheet and the tool during audits.",
    "Non-functional notes: the export should complete within thirty seconds for runs of up to ten thousand test cases, must not block the UI while generating, and should produce a file encoded as UTF-8 with a byte-order mark so that spreadsheet applications on Windows open it with correct character rendering for non-English test case titles.",
    "Out of scope for this story: scheduled or recurring exports, export of attachments and screenshots, PDF report generation, and pushing results to external dashboards. Those are tracked separately on the reporting epic and must not creep into this implementation.",
    "Accessibility and localisation: the export control must be reachable by keyboard, announced by screen readers, and its label localised in all supported languages. Error states (network failure mid-download, run deleted while exporting) need user-visible messages that support can reference in tickets.",
    "Security review noted the exported file may contain customer-identifiable test data, so the download must respect the same project-level permissions as the results page itself and be recorded in the audit log with the exporting user's identity.",
  ].join("\n"),
  acceptanceCriteria: [
    "Given a completed test run, when the user chooses export on the results page, then a CSV file containing every test result row of that run is downloaded.",
    "Given a run with more than ten thousand results, when the user exports, then the file is produced without freezing the browser tab.",
    "Given an export that fails mid-way, when the failure occurs, then the user sees an actionable error message and no partial file is saved.",
  ].join("\n"),
  tags: ["reporting", "compliance"],
});
const LONG_QUERY = requirementToRetrievalQuery(longRequirement);

describeDb("rerank retrieval quality (real model, real index)", () => {
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
      // Index without embedding, then embed explicitly below, so the test controls
      // exactly when the real model runs (matches embedding-retrieval.quality.db.test.ts).
      embeddingProvider: null,
    });
    await syncProjectChunkEmbeddings({ scope, provider: embeddingProvider });
  }, 300_000);

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM embeddings WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @p`, { p: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @p`, { p: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("scores the genuinely relevant chunk above a lexically denser but topically wrong one", async () => {
    // Isolates the reranker's own judgment from retrieval/fusion/chunking timing
    // entirely -- built from the exact same chunk-splitting function the indexing
    // pipeline uses (workItemToContextUnits), so this is provably the real input,
    // not a hand-copied approximation of it.
    expect(rerankProvider).not.toBeNull();
    const rightCore = workItemToContextUnits(rightItem)[0]!.text;
    const wrongCore = workItemToContextUnits(wrongItem)[0]!.text;

    const scores = await rerankProvider!.rerank(QUERY, [wrongCore, rightCore]);
    expect(scores[1]).toBeGreaterThan(scores[0]!);
  }, 180_000);

  it("ranks the genuinely relevant work item first once reranking is applied to hybrid search", async () => {
    const reranked = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery(QUERY) ?? "",
      rawQuery: QUERY,
      topK: 3,
      embeddingProvider,
      rerankProvider,
    });
    expect(reranked[0]!.row.azure_work_item_id).toBe(RIGHT_ID);
  }, 300_000);

  it("does not disturb a fused order that was already correct", async () => {
    // Measured, not assumed: on this corpus fusion ALREADY ranks the right item first
    // without any reranking (the embedding model's cosine similarity outvotes the
    // lexical density trap). So the test above is not proof that reranking rescued a
    // bad order -- it proves reranking preserved a good one, which is the property
    // that actually matters most in production, where fusion is usually right and a
    // reranker's job is to improve the margin without breaking the wins.
    //
    // Deliberately NOT "fixed" by making the wrong item denser until fusion trips:
    // that would be fitting the fixture to a desired narrative. A case where
    // reranking genuinely overturns fusion would need a corpus of many real
    // questions, measured in aggregate rather than argued from one hand-built pair.
    const baseline = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery(QUERY) ?? "",
      rawQuery: QUERY,
      topK: 3,
      embeddingProvider,
      rerankProvider: null,
    });
    expect(baseline[0]!.row.azure_work_item_id).toBe(RIGHT_ID);
  }, 300_000);

  it("still prefers the right passage when the query is a full requirement, not a question", async () => {
    // The regime the other tests never enter: the cross-encoder's 512-token window
    // covers query and passage COMBINED, and workflow auto-context queries are whole
    // requirements. Without the asymmetric query cap (MAX_RERANK_QUERY_CHARS), a
    // near-2000-char query could consume essentially the entire window and leave the
    // model scoring the query against a stump of each passage.
    expect(LONG_QUERY.length).toBeGreaterThan(2000);

    const rightCore = workItemToContextUnits(rightItem)[0]!.text;
    const wrongCore = workItemToContextUnits(wrongItem)[0]!.text;

    const scores = await rerankProvider!.rerank(LONG_QUERY, [wrongCore, rightCore]);
    expect(scores[1]).toBeGreaterThan(scores[0]!);
  }, 180_000);

  it("ranks the right item first in hybrid search for a full-requirement query", async () => {
    const reranked = await searchProjectChunksHybrid({
      scope,
      ftsQuery: buildFtsQuery(LONG_QUERY) ?? "",
      rawQuery: LONG_QUERY,
      topK: 3,
      embeddingProvider,
      rerankProvider,
    });
    expect(reranked[0]!.row.azure_work_item_id).toBe(RIGHT_ID);
  }, 300_000);
});
