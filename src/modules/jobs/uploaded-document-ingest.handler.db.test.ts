import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import sharp from "sharp";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

// The handler's only expensive/non-deterministic dependency is the local
// embedding sync; every other import (parser, storage, chunker, FTS mirror,
// audit log) runs for real against Postgres. Mock precisely the specifier the
// handler imports (`@/modules/rag/embedding-store.service`) and nothing else.
const embeddingMocks = vi.hoisted(() => ({
  syncProjectDocumentEmbeddings: vi.fn(async () => ({ embeddedChunkCount: 0, removedCount: 0 })),
}));
vi.mock("@/modules/rag/embedding-store.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/rag/embedding-store.service")>(),
  syncProjectDocumentEmbeddings: embeddingMocks.syncProjectDocumentEmbeddings,
}));

import {
  flushBackgroundWrites,
  resetDatabaseForTests,
  sqlAll,
  sqlRun,
} from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  createDocumentWithVersion,
  getProjectSourceDocumentVersion,
  listProjectSourceDocumentChunks,
} from "@/modules/documents/project-source-documents.service";
import { createLocalFilesystemStorageBackend } from "@/modules/documents/storage/local-filesystem-backend";
import { UPLOADED_DOCUMENT_INGEST } from "@/modules/jobs/uploaded-document-jobs.service";
import { retrieveStoredProjectContext } from "@/modules/rag/project-context-store.service";
import type { Job } from "@/modules/jobs/job-queue.service";
import type { JobHandlerContext } from "@/modules/jobs/job-handlers";
import { runUploadedDocumentIngestJob } from "./uploaded-document-ingest.handler";

const WS = uniqueTestId("ws_ingest");
const ORG = `https://dev.azure.com/${WS}`;
const PROJECT = uniqueTestId("az_ingest");

const scope: ProjectScope = {
  projectId: PROJECT,
  azureProjectId: PROJECT,
  azureProjectName: "Ingest Handler Project",
  azureOrganizationUrl: ORG,
  workspaceId: WS,
};

let previousStorageRoot: string | undefined;
let tempStorageRoot: string;

function sha256Hex(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function buildJob(payload: Record<string, unknown>): Job {
  const now = new Date().toISOString();
  return {
    id: uniqueTestId("job"),
    workspaceId: WS,
    projectId: PROJECT,
    jobType: UPLOADED_DOCUMENT_INGEST,
    payload,
    dedupeKey: null,
    status: "pending",
    priority: 0,
    attempts: 0,
    maxAttempts: 3,
    lockedBy: null,
    lockedAt: null,
    runAfter: now,
    errorMessage: null,
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function buildContext(): { context: JobHandlerContext; updateProgress: ReturnType<typeof vi.fn> } {
  const controller = new AbortController();
  const updateProgress = vi.fn(async () => undefined);
  return {
    context: { workerId: uniqueTestId("worker"), signal: controller.signal, updateProgress },
    updateProgress,
  };
}

describeDb("uploaded document ingest handler (DB-backed, embeddings mocked)", () => {
  beforeAll(async () => {
    previousStorageRoot = process.env.DOCUMENT_STORAGE_ROOT;
    tempStorageRoot = await mkdtemp(path.join(tmpdir(), "itf-doc-ingest-"));
    process.env.DOCUMENT_STORAGE_ROOT = tempStorageRoot;

    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({
      workspaceId: WS,
      orgUrl: ORG,
      azureProjectId: PROJECT,
      azureProjectName: "Ingest Handler Project",
    });
  });

  afterAll(async () => {
    await flushBackgroundWrites();
    await sqlRun(`DELETE FROM document_chunks_fts WHERE project_id = @projectId`, { projectId: PROJECT });
    await sqlRun(`DELETE FROM document_chunks WHERE project_id = @projectId`, { projectId: PROJECT });
    await sqlRun(`UPDATE project_source_documents SET current_version_id = NULL WHERE workspace_id = @ws`, { ws: WS });
    await sqlRun(`DELETE FROM project_source_document_versions WHERE workspace_id = @ws`, { ws: WS });
    await sqlRun(`DELETE FROM project_source_documents WHERE workspace_id = @ws`, { ws: WS });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();

    if (previousStorageRoot === undefined) delete process.env.DOCUMENT_STORAGE_ROOT;
    else process.env.DOCUMENT_STORAGE_ROOT = previousStorageRoot;
    await rm(tempStorageRoot, { recursive: true, force: true });
  });

  it("parses a stored text document end-to-end: chunks, FTS mirror rows, and parse_status='parsed'", async () => {
    const backend = createLocalFilesystemStorageBackend();
    const content = Buffer.from(
      "Getting started\n\n" +
        "This is a small uploaded test document used to exercise the ingest handler.\n\n" +
        "It has more than one paragraph so the chunker has real text to split and section.\n",
      "utf8",
    );
    const contentHash = sha256Hex(content);
    const stored = await backend.put({
      workspaceId: WS,
      contentSha256: contentHash,
      content: Readable.from([content]),
      expectedByteSize: content.length,
    });

    const created = await createDocumentWithVersion({
      scope,
      documentName: "Ingest handler sample",
      createdBy: uniqueTestId("user"),
      version: {
        storageKey: stored.storageKey,
        originalFileName: "notes.txt",
        mimeType: "text/plain",
        fileFormat: "txt",
        byteSize: stored.byteSize,
        contentHash,
        uploadedBy: uniqueTestId("user"),
      },
    });

    const job = buildJob({ projectId: PROJECT, versionId: created.version.id });
    const { context, updateProgress } = buildContext();

    const result = await runUploadedDocumentIngestJob(job, context);

    expect(result).toMatchObject({
      outcome: "parsed",
      documentId: created.document.id,
      versionId: created.version.id,
      parseStatus: "parsed",
    });
    expect((result as Record<string, unknown>).chunkCount as number).toBeGreaterThan(0);
    expect(updateProgress).toHaveBeenCalled();
    expect(embeddingMocks.syncProjectDocumentEmbeddings).toHaveBeenCalled();

    const version = await getProjectSourceDocumentVersion({ scope, versionId: created.version.id });
    expect(version?.parseStatus).toBe("parsed");
    expect(version?.chunkCount).toBeGreaterThan(0);

    const chunks = await sqlAll<{
      source_type: string;
      workspace_id: string;
      project_id: string;
      azure_project_id: string;
      document_id: string;
      source_document_version_id: string;
      section: string | null;
    }>(
      `SELECT source_type, workspace_id, project_id, azure_project_id, document_id, source_document_version_id, section
       FROM document_chunks
       WHERE project_id = @projectId AND document_id = @documentId AND source_document_version_id = @versionId`,
      { projectId: PROJECT, documentId: created.document.id, versionId: created.version.id },
    );
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.source_type).toBe("uploaded_document");
      expect(chunk.workspace_id).toBe(WS);
      expect(chunk.project_id).toBe(PROJECT);
      expect(chunk.azure_project_id).toBe(PROJECT);
      expect(chunk.section).toBeTruthy();
    }

    const ftsRows = await sqlAll<{ chunk_id: string }>(
      `SELECT chunk_id FROM document_chunks_fts WHERE project_id = @projectId AND document_id = @documentId`,
      { projectId: PROJECT, documentId: created.document.id },
    );
    expect(ftsRows.length).toBe(chunks.length);
  });

  it.each([
    { language: "eng", visibleText: "PAYMENT GATEWAY", expectedText: "PAYMENT GATEWAY", direction: "ltr" },
    { language: "ara", visibleText: "مرحبا", expectedText: "مرحبا", direction: "rtl" },
  ] as const)("persists and retrieves real $language OCR context with image provenance", async ({ language, visibleText, expectedText, direction }) => {
    const backend = createLocalFilesystemStorageBackend();
    const content = await sharp(Buffer.from(
      `<svg width="800" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="white"/><text x="400" y="105" text-anchor="middle" direction="${direction}" font-family="DejaVu Sans" font-size="64">${visibleText}</text></svg>`,
    )).png().toBuffer();
    const contentHash = sha256Hex(content);
    const stored = await backend.put({
      workspaceId: WS,
      contentSha256: contentHash,
      content: Readable.from([content]),
      expectedByteSize: content.length,
    });
    const created = await createDocumentWithVersion({
      scope,
      documentName: `${language} OCR provenance sample`,
      languageHint: language,
      createdBy: uniqueTestId("user"),
      version: {
        storageKey: stored.storageKey,
        originalFileName: "ocr-source.png",
        mimeType: "image/png",
        fileFormat: "png",
        byteSize: stored.byteSize,
        contentHash,
        uploadedBy: uniqueTestId("user"),
      },
    });

    const result = await runUploadedDocumentIngestJob(
      buildJob({ projectId: PROJECT, versionId: created.version.id }),
      buildContext().context,
    );

    expect(result).toMatchObject({ outcome: "parsed", parseStatus: "parsed", chunkCount: 1 });
    expect(created.document.documentKind).toBe("image");
    const version = await getProjectSourceDocumentVersion({ scope, versionId: created.version.id });
    expect(version?.metadata.ocr).toEqual(expect.objectContaining({
      engine: "tesseract.js",
      language,
      status: "parsed",
      acceptedRegionCount: 1,
      rejectedRegionCount: 0,
    }));
    const chunks = await listProjectSourceDocumentChunks({
      scope,
      documentId: created.document.id,
      sourceDocumentVersionId: created.version.id,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toContain(expectedText);
    expect(chunks[0]).toMatchObject({
      documentId: created.document.id,
      sourceDocumentVersionId: created.version.id,
      section: "ocr-region-1",
      metadata: {
        origin: "ocr_text",
        engine: "tesseract.js",
        engineVersion: expect.any(String),
        language,
        confidence: expect.any(Number),
        bbox: { x0: expect.any(Number), y0: expect.any(Number), x1: expect.any(Number), y1: expect.any(Number) },
      },
    });

    const retrieved = await retrieveStoredProjectContext({
      scope,
      query: expectedText,
      embeddingProvider: null,
      rerankProvider: null,
      sourceKinds: ["uploaded_document"],
    });
    expect(retrieved).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sourceType: "uploaded_document",
        documentId: created.document.id,
        documentVersionId: created.version.id,
        content: expect.stringContaining(expectedText),
      }),
    ]));
  }, 30_000);

  it("a corrupted DOCX buffer completes without throwing and ends parse_failed with parse_error set", async () => {
    const backend = createLocalFilesystemStorageBackend();
    // A ZIP local-file-header signature followed by non-ZIP garbage: enough to make
    // mammoth attempt to open it as an OOXML package, but not enough to succeed at
    // either convertToHtml or the extractRawText fallback -- both throw, and the
    // docx parser's documentParseError() maps that to code "corrupted".
    const corrupted = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("not-a-real-docx-body-garbage-bytes-1234567890", "utf8"),
    ]);
    const contentHash = sha256Hex(corrupted);
    const stored = await backend.put({
      workspaceId: WS,
      contentSha256: contentHash,
      content: Readable.from([corrupted]),
      expectedByteSize: corrupted.length,
    });

    const created = await createDocumentWithVersion({
      scope,
      documentName: "Corrupted docx sample",
      createdBy: uniqueTestId("user"),
      version: {
        storageKey: stored.storageKey,
        originalFileName: "broken.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileFormat: "docx",
        byteSize: stored.byteSize,
        contentHash,
        uploadedBy: uniqueTestId("user"),
      },
    });

    const job = buildJob({ projectId: PROJECT, versionId: created.version.id });
    const { context } = buildContext();

    // Must resolve, not reject: a DocumentParseError is caught inside the handler
    // and turned into a terminal parse_failed state rather than an uncaught throw.
    const result = await runUploadedDocumentIngestJob(job, context);
    expect(result).toMatchObject({
      outcome: "parse_failed",
      documentId: created.document.id,
      versionId: created.version.id,
      chunkCount: 0,
      parseStatus: "parse_failed",
    });

    const version = await getProjectSourceDocumentVersion({ scope, versionId: created.version.id });
    expect(version?.parseStatus).toBe("parse_failed");
    expect(version?.parseError).toBeTruthy();
    expect(version?.chunkCount).toBe(0);
  });
});
