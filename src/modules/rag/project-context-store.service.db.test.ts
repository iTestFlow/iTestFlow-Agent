import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  flushBackgroundWrites,
  getPool,
  resetDatabaseForTests,
  sqlAll,
  sqlGet,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import {
  advisoryLockKeyForProject,
  getRecentProjectContext,
  indexAzureWorkItemsAsProjectContext,
  retrieveStoredProjectContext,
  withEmbeddingSyncLock,
} from "@/modules/rag/project-context-store.service";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

// Per-run identifiers: this suite shares the database with other suites/agents, so
// every row it writes is keyed under these unique project ids.
const WS = uniqueTestId("ws_ctxstore");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ_A = uniqueTestId("az_ctxstore_a");
const PROJ_B = uniqueTestId("az_ctxstore_b");
const PROJ_C = uniqueTestId("az_ctxstore_c");

const scopeA: ProjectScope = {
  projectId: PROJ_A,
  azureProjectId: PROJ_A,
  azureProjectName: "Context Store A",
  azureOrganizationUrl: ORG,
};
const scopeB: ProjectScope = {
  projectId: PROJ_B,
  azureProjectId: PROJ_B,
  azureProjectName: "Context Store B",
  azureOrganizationUrl: ORG,
};
// Dedicated project for tests that don't belong to project A's carefully sequenced
// sync-lifecycle narrative (see the describeDb comment below) — keeps them from
// perturbing that scope's snapshot/revision history.
const scopeC: ProjectScope = {
  projectId: PROJ_C,
  azureProjectId: PROJ_C,
  azureProjectName: "Context Store C",
  azureOrganizationUrl: ORG,
};

const CHANGED_DESCRIPTION = "Customer completes checkout after the payment gateway approves the card.";

// Fixture content is chosen so each assertion has a unique token: "payment gateway"
// only in item 101 (project A), "zebra telemetry" only in project B, and literal
// "%" / "_" only in item 103 (the LIKE-escaping subject).
function checkoutItem(
  description = "Customer pays through the payment gateway during checkout.",
  revision = 10,
): Requirement {
  return requirement({
    id: "101",
    azureProjectId: PROJ_A,
    title: "Checkout flow",
    description,
    acceptanceCriteria: "Given a cart, when the gateway approves, then show confirmation.",
    tags: [],
    revision,
  });
}

function refundItem(): Requirement {
  return requirement({
    id: "102",
    azureProjectId: PROJ_A,
    title: "Refund flow",
    description: "Support agent issues a refund for a delivered order.",
    acceptanceCriteria: "Given a delivered order, when a refund is issued, then notify the customer.",
    tags: [],
    revision: 7,
  });
}

function rolloutItem(): Requirement {
  return requirement({
    id: "103",
    azureProjectId: PROJ_A,
    title: "Rollout 100% complete",
    description: "Track rollout progress across regions at a 50_percent sample rate.",
    acceptanceCriteria: "Given a region, when rollout reaches full coverage, then close the tracker.",
    tags: [],
    revision: 3,
  });
}

// Deliberately reuses Azure work item id "101" so cross-project assertions prove
// scoping keys on the project, not on the work item id.
function telemetryItem(): Requirement {
  return requirement({
    id: "101",
    azureProjectId: PROJ_B,
    title: "Telemetry pipeline",
    description: "Ingest zebra telemetry events from devices.",
    acceptanceCriteria: "Given a device, when events arrive, then store them.",
    tags: [],
    revision: 4,
  });
}

async function sync(scope: ProjectScope, items: Requirement[]) {
  return indexAzureWorkItemsAsProjectContext({
    scope,
    actor: "db-test",
    adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => items) }),
    workItemTypes: ["User Story"],
    states: ["Active"],
  });
}

type WorkItemRow = {
  id: string;
  azure_work_item_id: string;
  sync_status: string | null;
  content_hash: string | null;
  current_index_run_id: string | null;
  current_snapshot_id: string | null;
  created_at: string;
};

async function workItemRows(projectId: string): Promise<WorkItemRow[]> {
  return sqlAll<WorkItemRow>(
    `SELECT id, azure_work_item_id, sync_status, content_hash, current_index_run_id,
            current_snapshot_id, created_at
     FROM azure_devops_work_items
     WHERE project_id = @projectId
     ORDER BY azure_work_item_id`,
    { projectId },
  );
}

async function chunkRows(projectId: string) {
  return sqlAll<{ id: string; azure_work_item_id: string | null; chunk_index: number; content: string; source_snapshot_id: string | null; created_at: string; updated_at: string }>(
    `SELECT id, azure_work_item_id, chunk_index, content, source_snapshot_id, created_at, updated_at
     FROM document_chunks
     WHERE project_id = @projectId AND source_type = 'azure_work_item'
     ORDER BY id`,
    { projectId },
  );
}

// Projection without current_index_run_id (the one column an unchanged run rewrites).
function stableColumns(rows: WorkItemRow[]) {
  return rows.map(({ id, azure_work_item_id, sync_status, content_hash, current_snapshot_id, created_at }) => ({
    id,
    azure_work_item_id,
    sync_status,
    content_hash,
    current_snapshot_id,
    created_at,
  }));
}

function chunkColumnsWithoutSnapshot(rows: Awaited<ReturnType<typeof chunkRows>>) {
  return rows.map((chunk) => ({
    id: chunk.id,
    azure_work_item_id: chunk.azure_work_item_id,
    chunk_index: chunk.chunk_index,
    content: chunk.content,
    created_at: chunk.created_at,
    updated_at: chunk.updated_at,
  }));
}

// Tests run in file order and advance one sync lifecycle for project A:
// create -> unchanged -> changed -> missing/inactive -> reactivated.
describeDb("project context store sync state machine (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ_A, azureProjectName: "Context Store A" });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ_B, azureProjectName: "Context Store B" });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ_C, azureProjectName: "Context Store C" });
  });

  afterAll(async () => {
    // Audit/knowledge-log writes are backgrounded; land them while the seeded
    // projects still exist, then delete feature rows before cleanupFixtures can
    // trip on their workspace_id FKs.
    await flushBackgroundWrites();
    for (const projectId of [PROJ_A, PROJ_B, PROJ_C]) {
      await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM azure_devops_work_item_snapshots WHERE project_id = @projectId`, { projectId });
      await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId });
    }
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("first incremental run inserts every fetched item as active with chunks", async () => {
    const fetchWorkItems = vi.fn(async () => [checkoutItem(), refundItem(), rolloutItem()]);
    const result = await indexAzureWorkItemsAsProjectContext({
      scope: scopeA,
      actor: "db-test",
      adapter: fakeAzureAdapter({ fetchWorkItems }),
      workItemTypes: ["User Story"],
      states: ["Active"],
    });

    // The adapter is queried with the scope's Azure project, never a raw client value.
    expect(fetchWorkItems).toHaveBeenCalledWith({
      projectId: PROJ_A,
      workItemTypes: ["User Story"],
      states: ["Active"],
    });
    expect(result).toMatchObject({
      mode: "incremental",
      fetchedCount: 3,
      createdCount: 3,
      updatedCount: 0,
      unchangedCount: 0,
      inactiveCount: 0,
      indexedWorkItemCount: 3,
      indexedChunkCount: 3,
      skippedEmptyCount: 0,
    });

    const rows = await workItemRows(PROJ_A);
    expect(rows.map((row) => row.azure_work_item_id)).toEqual(["101", "102", "103"]);
    expect(rows.every((row) => row.sync_status === "active")).toBe(true);
    expect(rows.every((row) => Boolean(row.content_hash))).toBe(true);
    expect(rows.every((row) => Boolean(row.current_snapshot_id))).toBe(true);

    // Short work items land as exactly one chunk each, keyed to their work item.
    const chunks = await chunkRows(PROJ_A);
    expect(chunks.map((chunk) => chunk.azure_work_item_id).sort()).toEqual(["101", "102", "103"]);
    expect(chunks.every((chunk) => Boolean(chunk.source_snapshot_id))).toBe(true);

    const snapshots = await sqlAll<{ azure_work_item_id: string; ado_revision: number; fields_json: unknown }>(
      `SELECT azure_work_item_id, ado_revision, fields_json
       FROM azure_devops_work_item_snapshots WHERE project_id = @projectId
       ORDER BY azure_work_item_id`,
      { projectId: PROJ_A },
    );
    expect(snapshots.map((snapshot) => [snapshot.azure_work_item_id, snapshot.ado_revision])).toEqual([
      ["101", 10],
      ["102", 7],
      ["103", 3],
    ]);
    expect(snapshots.every((snapshot) => !("raw" in (snapshot.fields_json as Record<string, unknown>)))).toBe(true);
  });

  it("uses work item ID as a deterministic tie-breaker across context batches", async () => {
    await sqlRun(
      `UPDATE azure_devops_work_items
       SET work_item_type = 'User Story',
           last_synced_at = '2026-07-14T10:00:00.000Z',
           updated_date = '2026-07-14T10:00:00.000Z'
       WHERE project_id = @projectId`,
      { projectId: PROJ_A },
    );

    const firstBatch = await getRecentProjectContext({
      scope: scopeA,
      page: 1,
      pageSize: 2,
      sortBy: "type",
      sortDirection: "asc",
    });
    const secondBatch = await getRecentProjectContext({
      scope: scopeA,
      page: 2,
      pageSize: 2,
      sortBy: "type",
      sortDirection: "asc",
    });

    expect([...firstBatch.items, ...secondBatch.items].map((item) => item.workItemId)).toEqual(["101", "102", "103"]);
  });

  it("re-running with unchanged content keeps items active without rewriting rows or chunks", async () => {
    const before = await workItemRows(PROJ_A);
    const chunksBefore = await chunkRows(PROJ_A);

    const result = await sync(scopeA, [checkoutItem(), refundItem(), rolloutItem()]);
    expect(result).toMatchObject({
      createdCount: 0,
      updatedCount: 0,
      unchangedCount: 3,
      inactiveCount: 0,
      indexedWorkItemCount: 0,
      indexedChunkCount: 0,
    });

    // Rows were claimed by the new run (fresh run id) but not rewritten: primary
    // keys, hashes, statuses and created_at are untouched.
    const after = await workItemRows(PROJ_A);
    expect(stableColumns(after)).toEqual(stableColumns(before));
    expect(after[0]?.current_index_run_id).not.toBe(before[0]?.current_index_run_id);

    // Chunks were not deleted and reinserted.
    expect(await chunkRows(PROJ_A)).toEqual(chunksBefore);
  });

  it("captures a new Azure revision snapshot without rebuilding semantic chunks", async () => {
    const beforeChunks = await chunkRows(PROJ_A);
    const before = (await workItemRows(PROJ_A)).find((row) => row.azure_work_item_id === "101");

    const result = await sync(scopeA, [checkoutItem(undefined, 11), refundItem(), rolloutItem()]);
    expect(result).toMatchObject({
      createdCount: 0,
      updatedCount: 0,
      unchangedCount: 3,
      provenanceRefreshCount: 1,
      indexedChunkCount: 0,
    });
    const after = (await workItemRows(PROJ_A)).find((row) => row.azure_work_item_id === "101");
    expect(after?.content_hash).toBe(before?.content_hash);
    expect(after?.current_snapshot_id).not.toBe(before?.current_snapshot_id);
    const afterChunks = await chunkRows(PROJ_A);
    expect(chunkColumnsWithoutSnapshot(afterChunks)).toEqual(chunkColumnsWithoutSnapshot(beforeChunks));
    expect(afterChunks.find((chunk) => chunk.azure_work_item_id === "101")?.source_snapshot_id)
      .toBe(after?.current_snapshot_id);
    expect(await sqlAll<{ ado_revision: number }>(
      `SELECT ado_revision FROM azure_devops_work_item_snapshots
       WHERE project_id = @projectId AND azure_work_item_id = '101'
       ORDER BY ado_revision`,
      { projectId: PROJ_A },
    )).toEqual([{ ado_revision: 10 }, { ado_revision: 11 }]);
  });

  it("changed content re-upserts the same row and rebuilds its chunk", async () => {
    const before = await workItemRows(PROJ_A);
    const beforeCheckout = before.find((row) => row.azure_work_item_id === "101");

    const result = await sync(scopeA, [checkoutItem(CHANGED_DESCRIPTION, 12), refundItem(), rolloutItem()]);
    expect(result).toMatchObject({
      createdCount: 0,
      updatedCount: 1,
      unchangedCount: 2,
      inactiveCount: 0,
      indexedWorkItemCount: 1,
    });

    // Upsert, not insert: the primary key survives while the hash tracks new content.
    const afterCheckout = (await workItemRows(PROJ_A)).find((row) => row.azure_work_item_id === "101");
    expect(afterCheckout?.id).toBe(beforeCheckout?.id);
    expect(afterCheckout?.content_hash).not.toBe(beforeCheckout?.content_hash);
    expect(afterCheckout?.sync_status).toBe("active");

    const chunk = await sqlGet<{ content: string }>(
      `SELECT content FROM document_chunks WHERE project_id = @projectId AND azure_work_item_id = '101'`,
      { projectId: PROJ_A },
    );
    expect(chunk?.content).toContain("approves the card");
  });

  it("items missing from the batch flip to inactive; the active set is exactly the survivors", async () => {
    const result = await sync(scopeA, [refundItem(), rolloutItem()]);
    expect(result).toMatchObject({ createdCount: 0, updatedCount: 0, unchangedCount: 2, inactiveCount: 1 });

    // Marking the wrong rows inactive silently shrinks the retrieval corpus, so the
    // surviving active set is asserted precisely, not just counted.
    const rows = await workItemRows(PROJ_A);
    expect(rows.filter((row) => row.sync_status === "active").map((row) => row.azure_work_item_id)).toEqual(["102", "103"]);
    expect(rows.find((row) => row.azure_work_item_id === "101")?.sync_status).toBe("inactive");

    // The inactive item's chunk stays on disk but stops feeding retrieval and listing.
    const orphanChunks = await sqlGet<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM document_chunks WHERE project_id = @projectId AND azure_work_item_id = '101'`,
      { projectId: PROJ_A },
    );
    expect(orphanChunks?.count).toBe(1);
    expect(await retrieveStoredProjectContext({ scope: scopeA, query: "payment gateway", embeddingProvider: null })).toEqual([]);

    const recent = await getRecentProjectContext({ scope: scopeA });
    expect(recent.totalCount).toBe(2);
    expect(recent.items.map((item) => item.workItemId).sort()).toEqual(["102", "103"]);
  });

  it("a reappearing inactive item is re-upserted to active instead of skipped as unchanged", async () => {
    // Content hash matches the stored row, but an inactive row must not take the
    // unchanged shortcut — otherwise it would stay invisible forever.
    const result = await sync(scopeA, [checkoutItem(CHANGED_DESCRIPTION, 12), refundItem(), rolloutItem()]);
    expect(result).toMatchObject({ createdCount: 0, updatedCount: 1, unchangedCount: 2, inactiveCount: 0 });

    const rows = await workItemRows(PROJ_A);
    expect(rows.filter((row) => row.sync_status === "active").map((row) => row.azure_work_item_id)).toEqual(["101", "102", "103"]);

    const sources = await retrieveStoredProjectContext({ scope: scopeA, query: "payment gateway", embeddingProvider: null });
    expect(sources.map((source) => source.workItemId)).toEqual(["101"]);
  });

  it("retrieval and listing stay inside the scoped project even for a colliding work item id", async () => {
    const result = await sync(scopeB, [telemetryItem()]);
    expect(result).toMatchObject({ createdCount: 1 });

    const fromB = await retrieveStoredProjectContext({ scope: scopeB, query: "zebra telemetry ingest", embeddingProvider: null });
    expect(fromB).toHaveLength(1);
    expect(fromB[0]).toMatchObject({ workItemId: "101", title: "Telemetry pipeline" });
    expect(fromB[0]?.content).toContain("zebra");

    // No leakage in either direction, even though both projects hold an item "101".
    expect(await retrieveStoredProjectContext({ scope: scopeA, query: "zebra telemetry ingest", embeddingProvider: null })).toEqual([]);
    expect(await retrieveStoredProjectContext({ scope: scopeB, query: "payment gateway", embeddingProvider: null })).toEqual([]);

    const recentA = await getRecentProjectContext({ scope: scopeA });
    expect(recentA.totalCount).toBe(3);
    expect(recentA.items.some((item) => item.title === "Telemetry pipeline")).toBe(false);

    const recentB = await getRecentProjectContext({ scope: scopeB });
    expect(recentB.totalCount).toBe(1);
    expect(recentB.items[0]).toMatchObject({ workItemId: "101", title: "Telemetry pipeline" });
  });

  it("search queries treat % and _ as literal characters, not LIKE wildcards", async () => {
    // "%" must match only rows containing a literal percent — unescaped it would
    // wildcard-match every row in the project.
    const percent = await getRecentProjectContext({ scope: scopeA, query: "%" });
    expect(percent.totalCount).toBe(1);
    expect(percent.items[0]?.workItemId).toBe("103");

    const literalPercent = await getRecentProjectContext({ scope: scopeA, query: "100%" });
    expect(literalPercent.items.map((item) => item.workItemId)).toEqual(["103"]);

    const literalUnderscore = await getRecentProjectContext({ scope: scopeA, query: "50_percent" });
    expect(literalUnderscore.items.map((item) => item.workItemId)).toEqual(["103"]);

    // Unescaped, '1__%' would wildcard-match every work item id (101/102/103).
    const wildcards = await getRecentProjectContext({ scope: scopeA, query: "1__%" });
    expect(wildcards.totalCount).toBe(0);
    expect(wildcards.items).toEqual([]);
  });

  it("ranks chunks matching more query terms above weaker matches with 0..1 bounded scores", async () => {
    // 102 matches refund + delivered + order; 101 matches only "checkout"; 103 matches nothing.
    const sources = await retrieveStoredProjectContext({
      scope: scopeA,
      query: "refund delivered order checkout",
      embeddingProvider: null,
    });

    expect(sources.map((source) => source.workItemId)).toEqual(["102", "101"]);
    expect(sources[0]?.relevanceScore).toBe(1);
    for (const source of sources) {
      expect(source.relevanceScore).toBeGreaterThan(0);
      expect(source.relevanceScore).toBeLessThanOrEqual(1);
    }
    expect(sources[0]!.relevanceScore).toBeGreaterThanOrEqual(sources[1]!.relevanceScore);
  });

  it("returns nothing for empty or unmatched queries instead of scanning the corpus", async () => {
    expect(await retrieveStoredProjectContext({ scope: scopeA, query: "", embeddingProvider: null })).toEqual([]);
    // Every term is 2 chars or fewer, so the built tsquery is empty.
    expect(await retrieveStoredProjectContext({ scope: scopeA, query: "zz qq ab", embeddingProvider: null })).toEqual([]);
    expect(await retrieveStoredProjectContext({ scope: scopeA, query: "nonexistentterm", embeddingProvider: null })).toEqual([]);
  });

  it("explicit workItemIds fetch returns those items regardless of query match, scored 1", async () => {
    const sources = await retrieveStoredProjectContext({
      scope: scopeA,
      query: "words matching nothing indexed",
      workItemIds: ["102"],
    });
    expect(sources.map((source) => source.workItemId)).toEqual(["102"]);
    expect(sources[0]?.relevanceScore).toBe(1);
  });

  it("caps retrieval at one chunk per work item so a verbose item cannot crowd out weaker matches", async () => {
    const longInventory = requirement({
      id: "104",
      azureProjectId: PROJ_C,
      title: "Inventory sync",
      description: "Inventory warehouse reconciliation keeps counts aligned. ".repeat(100),
      acceptanceCriteria: "Given warehouse stock, when inventory syncs, then reconcile counts.",
      tags: [],
    });
    const shortInventory = requirement({
      id: "105",
      azureProjectId: PROJ_C,
      title: "Shelf counter",
      description: "Track inventory counts for each shelf.",
      acceptanceCriteria: "Given a shelf, when counts change, then update the display.",
      tags: [],
    });
    await sync(scopeC, [longInventory, shortInventory]);

    // The long item must genuinely span multiple chunks for this test to prove anything.
    const chunks104 = (await chunkRows(PROJ_C)).filter((chunk) => chunk.azure_work_item_id === "104");
    expect(chunks104.length).toBeGreaterThan(1);

    // Every 104 chunk matches both terms strongly; 105 matches only "inventory". Without
    // the per-work-item cap, 104's chunks would fill the result before 105 appears.
    const sources = await retrieveStoredProjectContext({ scope: scopeC, query: "inventory warehouse", embeddingProvider: null });
    expect(sources.map((source) => source.workItemId)).toEqual(["104", "105"]);
  });

  it("skips embedding sync work when another sync already holds the project's advisory lock", async () => {
    const lockTestProjectId = uniqueTestId("lock_project");
    const [key1, key2] = advisoryLockKeyForProject(lockTestProjectId);
    const holderClient = await getPool().connect();
    try {
      const held = await sqlGet<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(@key1, @key2) AS locked",
        { key1, key2 },
        holderClient,
      );
      expect(held?.locked).toBe(true);

      const fn = vi.fn(async () => "should not run");
      const outcome = await withEmbeddingSyncLock(lockTestProjectId, fn);
      expect(outcome).toEqual({ acquired: false });
      expect(fn).not.toHaveBeenCalled();
    } finally {
      await sqlRun("SELECT pg_advisory_unlock(@key1, @key2)", { key1, key2 }, holderClient);
      holderClient.release();
    }

    // Once released, the next call proceeds and runs fn normally.
    const outcome = await withEmbeddingSyncLock(lockTestProjectId, async () => "ran");
    expect(outcome).toEqual({ acquired: true, result: "ran" });
  });

  it("rebuild replaces the current source set but preserves immutable snapshot history", async () => {
    const beforeSnapshots = await sqlAll<{ id: string }>(
      `SELECT id FROM azure_devops_work_item_snapshots WHERE project_id = @projectId ORDER BY id`,
      { projectId: PROJ_A },
    );
    const result = await indexAzureWorkItemsAsProjectContext({
      scope: scopeA,
      actor: "db-test",
      adapter: fakeAzureAdapter({ fetchWorkItems: vi.fn(async () => [refundItem(), rolloutItem()]) }),
      workItemTypes: ["User Story"],
      states: ["Active"],
      mode: "rebuild",
    });

    expect(result).toMatchObject({ mode: "rebuild", fetchedCount: 2, createdCount: 2 });
    expect((await workItemRows(PROJ_A)).map((row) => row.azure_work_item_id)).toEqual(["102", "103"]);
    expect(await sqlAll<{ id: string }>(
      `SELECT id FROM azure_devops_work_item_snapshots WHERE project_id = @projectId ORDER BY id`,
      { projectId: PROJ_A },
    )).toEqual(beforeSnapshots);
    expect(await sqlGet<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM azure_devops_work_item_snapshots
       WHERE project_id = @projectId AND azure_work_item_id = '101'`,
      { projectId: PROJ_A },
    )).toEqual({ count: 3 });
  });
});
