import { createHash } from "node:crypto";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

import {
  createId,
  flushBackgroundWrites,
  nowIso,
  resetDatabaseForTests,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import {
  indexAzureWorkItemsAsProjectContext,
  retrieveStoredProjectContext,
} from "@/modules/rag/project-context-store.service";
import {
  syncProjectChunkEmbeddings,
  syncProjectDocumentEmbeddings,
} from "@/modules/rag/embedding-store.service";
import { refreshProjectContextSearchIndex } from "@/modules/rag/context-chatbot-retrieval.service";
import {
  archiveProjectSourceDocument,
  createDocumentWithVersion,
  createVersionForDocument,
} from "@/modules/documents/project-source-documents.service";
import type { EmbeddingProvider } from "@/modules/rag/embedding-provider";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { fakeAzureAdapter, requirement } from "@/test/factories";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

/**
 * Regression coverage for the #1 blocking risk in the external-data-sources plan:
 * an ADO-only project's hybrid retrieval results must be byte-identical whether a
 * caller omits `sourceKinds` (the default, which includes "uploaded_document") or
 * explicitly pins `sourceKinds: ["azure_work_item"]`. That equivalence is produced
 * by hybrid-chunk-search.ts's existence gate (sourceKindsNeedDocumentExistenceCheck /
 * narrowSourceKindsForRetrieval), which collapses the default sourceKinds down to
 * ["azure_work_item"] whenever a project has zero *active* uploaded-document chunks.
 * This suite pins that gate directly against the real uploaded-document lifecycle:
 * an active document's chunks must participate in default retrieval and be excluded
 * by a pinned azure_work_item-only call; an archived document (or one whose chunks
 * belong to a non-current version) must fall out of BOTH -- collapsing the default
 * call's behavior back to exactly the pinned call's shape.
 *
 * Per-run identifiers: this suite shares the database with other suites/agents, so
 * every row it writes is keyed under these unique workspace/project ids.
 */
const WS = uniqueTestId("ws_docretrieve");
const ORG = `https://dev.azure.com/${WS}`;
const PROJ = uniqueTestId("az_docretrieve");

const scope: ProjectScope = {
  projectId: PROJ,
  azureProjectId: PROJ,
  azureProjectName: "Document Chunk Retrieval",
  azureOrganizationUrl: ORG,
  workspaceId: WS,
};

// Deterministic 3-dim "embeddings": one topic dimension per fixture family plus a
// constant so no vector is zero-norm. No vi.mock anywhere -- this fake provider is
// injected directly as the retrieval/sync `embeddingProvider`, mirroring the
// pattern in embedding-store.service.db.test.ts. It is also invoked by
// buildFtsQueryWithDynamicSynonyms's dynamic-synonym resolution with arbitrary
// vocabulary/unknown-term batches unrelated to any fixture content, so it must
// tolerate arbitrary text -- a substring-counting vector function does, safely.
const TOPIC_DIMENSIONS: Record<string, number> = {
  quota: 0,
  reconciliation: 1,
  audit: 2,
};

function textToVector(text: string): number[] {
  const lower = text.toLowerCase();
  const vector = [0.01, 0.01, 0.01, 1];
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

const provider = fakeEmbeddingProvider();

// Both work items share the literal word "quota" -- deliberately the exact same
// lexeme, not a differently-suffixed variant (e.g. "throttling" vs "throttled"):
// to_tsvector('simple', ...) does not stem, so a prefix-matched tsquery term only
// matches the identical lexeme it was built from.
function quotaLoginItem(): Requirement {
  return requirement({
    id: "601",
    azureProjectId: PROJ,
    title: "Login rate limiting",
    description: "Enforce a login quota per account to block brute-force attempts.",
    acceptanceCriteria: "Given repeated failed logins, when the quota is exceeded, then lock the account.",
    tags: [],
  });
}

function quotaExportItem(): Requirement {
  return requirement({
    id: "602",
    azureProjectId: PROJ,
    title: "Export throttling",
    description: "Apply a daily export quota so a single tenant cannot saturate the queue.",
    acceptanceCriteria: "Given a tenant near its quota, when it exports again, then reject the request.",
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

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Mirrors uploaded-document-ingest.handler.ts's INSERT_DOCUMENT_CHUNK_SQL exactly
 * (same column list, same NULLs for the azure_work_item-only columns) so the
 * fixture rows this suite writes are indistinguishable, at the row level, from
 * what the real ingest job produces for an uploaded_document chunk.
 */
async function insertDocumentChunk(input: {
  documentId: string;
  versionId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
}): Promise<string> {
  const id = createId("doc_chunk");
  const now = nowIso();
  await sqlRun(
    `
      INSERT INTO document_chunks (
        id, workspace_id, project_id, azure_project_id, azure_project_name, source_type,
        azure_work_item_id, work_item_type, document_id, source_document_version_id,
        document_name, document_type, section, page_number, chunk_index, content,
        metadata_json, source_snapshot_id, created_at, updated_at
      ) VALUES (
        @id, @workspaceId, @projectId, @azureProjectId, @azureProjectName, 'uploaded_document',
        NULL, NULL, @documentId, @sourceDocumentVersionId,
        @documentName, @documentType, @section, @pageNumber, @chunkIndex, @content,
        @metadataJson, NULL, @createdAt, @updatedAt
      )
    `,
    {
      id,
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      documentId: input.documentId,
      sourceDocumentVersionId: input.versionId,
      documentName: input.documentName,
      documentType: "txt",
      section: "body",
      pageNumber: null,
      chunkIndex: input.chunkIndex,
      content: input.content,
      metadataJson: "{}",
      createdAt: now,
      updatedAt: now,
    },
  );
  return id;
}

// Tests run in file order and advance one narrative for a single ADO-only project
// that later gains, then loses (archive, then version replacement), uploaded
// documents: byte-identical (ADO-only) -> document included -> document archived
// (byte-identical again) -> replacement document's stale version excluded.
describeDb("document chunk retrieval across source kinds and document lifecycle (DB-backed)", () => {
  let adoOnlyPinnedSnapshot: Awaited<ReturnType<typeof retrieveStoredProjectContext>>;
  let documentAId: string;
  let documentBId: string;

  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({ workspaceId: WS, orgUrl: ORG, azureProjectId: PROJ, azureProjectName: "Document Chunk Retrieval" });

    await sync([quotaLoginItem(), quotaExportItem()]);
    await syncProjectChunkEmbeddings({ scope, provider });
  });

  afterAll(async () => {
    // Audit/knowledge-log writes are backgrounded; land them while the seeded
    // project still exists, then delete feature rows in FK-safe order before
    // cleanupFixtures can trip on workspace_id/project_id FKs. The document
    // registry's current_version_id pointer is nulled before its versions are
    // deleted, mirroring project-source-documents.service.db.test.ts's cleanup.
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM embeddings WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`UPDATE project_source_documents SET current_version_id = NULL WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_source_document_versions WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_source_documents WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_items WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM azure_devops_work_item_snapshots WHERE project_id = @projectId`, { projectId: PROJ });
    await sqlRun(`DELETE FROM project_knowledge_log WHERE project_id = @projectId`, { projectId: PROJ });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("case 1: an ADO-only project returns byte-identical results for default vs pinned azure_work_item sourceKinds", async () => {
    const defaultResult = await retrieveStoredProjectContext({
      scope,
      query: "quota",
      embeddingProvider: provider,
      rerankProvider: null,
    });
    const pinnedResult = await retrieveStoredProjectContext({
      scope,
      query: "quota",
      embeddingProvider: provider,
      rerankProvider: null,
      sourceKinds: ["azure_work_item"],
    });

    // Both work items mention "quota", so this is a non-vacuous, multi-row result --
    // otherwise an empty-array-equals-empty-array comparison would prove nothing.
    expect(pinnedResult.length).toBeGreaterThan(0);
    expect(defaultResult).toEqual(pinnedResult);
    expect(pinnedResult.every((source) => source.sourceType === "azure_work_item")).toBe(true);

    adoOnlyPinnedSnapshot = pinnedResult;
  });

  it("case 2: an active uploaded-document chunk is returned by default sourceKinds and excluded when pinned to azure_work_item", async () => {
    const contentHash = sha256Hex(`${PROJ}-docA-v1`);
    const created = await createDocumentWithVersion({
      scope,
      documentName: "Reconciliation procedure",
      createdBy: "db-test",
      version: {
        storageKey: `ws/${WS}/docA/v1`,
        originalFileName: "docA.txt",
        mimeType: "text/plain",
        fileFormat: "txt",
        byteSize: 1024,
        contentHash,
        uploadedBy: "db-test",
      },
    });
    documentAId = created.document.id;

    await insertDocumentChunk({
      documentId: created.document.id,
      versionId: created.version.id,
      documentName: created.document.documentName,
      chunkIndex: 0,
      content: "The reconciliation team performs monthly invoice reconciliation across all vendor accounts.",
    });
    await refreshProjectContextSearchIndex({ scope });
    await syncProjectDocumentEmbeddings({ scope, provider });

    const withDefaultKinds = await retrieveStoredProjectContext({
      scope,
      query: "reconciliation",
      embeddingProvider: provider,
      rerankProvider: null,
    });
    expect(
      withDefaultKinds.some(
        (source) => source.sourceType === "uploaded_document" && source.documentId === documentAId,
      ),
    ).toBe(true);

    const pinnedAdoOnly = await retrieveStoredProjectContext({
      scope,
      query: "reconciliation",
      embeddingProvider: provider,
      rerankProvider: null,
      sourceKinds: ["azure_work_item"],
    });
    // Semantic retrieval is top-K ranking, not boolean matching: the nearest
    // ADO chunks still come back for an off-topic query, so the invariant is
    // "no document-sourced rows", never "empty results".
    expect(pinnedAdoOnly.every((source) => source.sourceType === "azure_work_item")).toBe(true);
  });

  it("case 3: archiving the only active document excludes its chunks and restores the ADO-only byte-identical shape", async () => {
    await archiveProjectSourceDocument({ scope, documentId: documentAId, archivedBy: "db-test" });
    // Mirrors the production archive route (src/app/api/context/documents/[documentId]/archive/route.ts),
    // which refreshes the FTS mirror in the same transaction as the archive.
    await refreshProjectContextSearchIndex({ scope });

    const documentQueryAfterArchive = await retrieveStoredProjectContext({
      scope,
      query: "reconciliation",
      embeddingProvider: provider,
      rerankProvider: null,
    });
    // Top-K ranking still surfaces the nearest ADO chunks; the archived
    // document's chunks specifically must be gone.
    expect(documentQueryAfterArchive.some((source) => source.sourceType === "uploaded_document")).toBe(false);

    // The existence gate re-evaluates per call: with zero active uploaded-document
    // chunks left in the project, default sourceKinds collapses back to
    // ["azure_work_item"] and the ADO-only query is byte-identical again -- both to
    // a freshly pinned call, and to the very first snapshot from case 1 (archiving
    // documentA changed nothing about the ADO chunks/embeddings).
    const defaultAfterArchive = await retrieveStoredProjectContext({
      scope,
      query: "quota",
      embeddingProvider: provider,
      rerankProvider: null,
    });
    const pinnedAfterArchive = await retrieveStoredProjectContext({
      scope,
      query: "quota",
      embeddingProvider: provider,
      rerankProvider: null,
      sourceKinds: ["azure_work_item"],
    });
    expect(defaultAfterArchive).toEqual(pinnedAfterArchive);
    expect(defaultAfterArchive).toEqual(adoOnlyPinnedSnapshot);
  });

  it("case 4: chunks belonging to a non-current document version are excluded by the current-version predicate", async () => {
    const contentHashV1 = sha256Hex(`${PROJ}-docB-v1`);
    const created = await createDocumentWithVersion({
      scope,
      documentName: "Audit checklist",
      createdBy: "db-test",
      version: {
        storageKey: `ws/${WS}/docB/v1`,
        originalFileName: "docB.txt",
        mimeType: "text/plain",
        fileFormat: "txt",
        byteSize: 2048,
        contentHash: contentHashV1,
        uploadedBy: "db-test",
      },
    });
    documentBId = created.document.id;
    const versionOneId = created.version.id;

    await insertDocumentChunk({
      documentId: documentBId,
      versionId: versionOneId,
      documentName: created.document.documentName,
      chunkIndex: 0,
      content: "The quarterly compliance audit checklist requires evidence review for every control.",
    });
    await refreshProjectContextSearchIndex({ scope });
    await syncProjectDocumentEmbeddings({ scope, provider });

    // Sanity check: version 1's chunk is genuinely retrievable before replacement,
    // so its later exclusion proves the current-version predicate, not a vacuous
    // "it was never findable" false positive.
    const beforeReplacement = await retrieveStoredProjectContext({
      scope,
      query: "audit",
      embeddingProvider: provider,
      rerankProvider: null,
    });
    expect(beforeReplacement.some((source) => source.sourceType === "uploaded_document" && source.documentId === documentBId)).toBe(true);

    // Simulate a replacement upload: a new version row exists and current_version_id
    // now points at it, but (mirroring the real async ingest gap -- see
    // src/app/api/context/documents/[documentId]/versions/route.ts, which refreshes
    // the FTS mirror in the SAME transaction as the version bump, before the new
    // version's chunks are parsed) no version-2 chunks have been inserted yet.
    await createVersionForDocument({
      scope,
      documentId: documentBId,
      version: {
        storageKey: `ws/${WS}/docB/v2`,
        originalFileName: "docB-v2.txt",
        mimeType: "text/plain",
        fileFormat: "txt",
        byteSize: 2100,
        contentHash: sha256Hex(`${PROJ}-docB-v2`),
        uploadedBy: "db-test",
      },
    });
    await refreshProjectContextSearchIndex({ scope });

    const afterReplacement = await retrieveStoredProjectContext({
      scope,
      query: "audit",
      embeddingProvider: provider,
      rerankProvider: null,
    });
    // Nearest ADO chunks may still rank for "audit"; what the current-version
    // predicate guarantees is that version 1's chunks (no longer the current
    // version) stop being retrievable.
    expect(afterReplacement.some((source) => source.sourceType === "uploaded_document")).toBe(false);
  });
});
