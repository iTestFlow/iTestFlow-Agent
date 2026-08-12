import { Readable } from "node:stream";

import { expect, it, vi } from "vitest";

import { DocumentParseError } from "@/modules/documents/parsed-document.types";
import type { Job } from "./job-queue.service";

const mocks = vi.hoisted(() => ({
  parseDocument: vi.fn(),
  updateVersionParseState: vi.fn(async () => undefined),
  writeAuditLog: vi.fn(),
  sqlRun: vi.fn(async () => ({ changes: 1 })),
  lifecycleStatus: "active",
}));

vi.mock("@/modules/documents/document-parser-registry", () => ({
  DOCUMENT_PARSE_RECIPE_VERSION: "test-recipe",
  parseDocument: mocks.parseDocument,
}));
vi.mock("@/modules/documents/document-storage.service", () => ({
  getDocumentStorageBackend: () => ({ getStream: async () => Readable.from([Buffer.from("image")]) }),
}));
vi.mock("@/modules/documents/project-source-documents.service", () => ({
  getProjectSourceDocumentVersion: async () => ({
    id: "version-1", documentId: "document-1", storageKey: "stored/image.png", byteSize: 5,
    fileFormat: "png", originalFileName: "sample.png",
    metadata: { detectedMimeType: "image/png", uploadByteLength: 5, image: { width: 100, height: 50 } },
  }),
  getProjectSourceDocument: async () => ({
    id: "document-1", documentName: "Arabic scan", languageHint: "ar", lifecycleStatus: mocks.lifecycleStatus,
  }),
  updateVersionParseState: mocks.updateVersionParseState,
}));
vi.mock("@/modules/documents/document-upload-validation", () => ({ getDocumentMaxUploadBytes: () => 1024 }));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/rag/embedding-store.service", () => ({
  syncProjectDocumentEmbeddings: vi.fn(async () => ({ embeddedChunkCount: 0, removedCount: 0 })),
}));
vi.mock("@/modules/rag/context-chatbot-retrieval.service", () => ({ refreshProjectContextSearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/modules/rag/project-knowledge-lock", () => ({ acquireProjectKnowledgeLock: vi.fn(async () => undefined) }));
vi.mock("@/modules/rag/project-knowledge-draft.service", () => ({ markProjectKnowledgeSourceDrift: vi.fn(async () => undefined) }));
vi.mock("@/modules/rag/project-context-store.service", () => ({
  withEmbeddingSyncLock: vi.fn(async (_projectId: string, callback: () => unknown) => ({ acquired: true, result: await callback() })),
}));
vi.mock("@/modules/shared/infrastructure/database/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/shared/infrastructure/database/db")>()),
  sqlGet: async () => ({ azure_project_id: "azure-1", azure_project_name: "Project", azure_organization_url: "https://dev.azure.com/org" }),
  sqlRun: mocks.sqlRun,
  withTransaction: async (callback: (client: unknown) => unknown) => callback({}),
}));

import { runUploadedDocumentIngestJob } from "./uploaded-document-ingest.handler";

it("passes the document language hint into image parsing", async () => {
  mocks.parseDocument.mockRejectedValueOnce(new DocumentParseError({ code: "corrupted", message: "stop after parse" }));
  const now = new Date().toISOString();
  const job = {
    id: "job-1", workspaceId: "workspace-1", projectId: "project-1", jobType: "uploaded_document_ingest",
    payload: { projectId: "project-1", versionId: "version-1" }, dedupeKey: null, status: "pending",
    priority: 0, attempts: 0, maxAttempts: 3, lockedBy: null, lockedAt: null, runAfter: now,
    errorMessage: null, createdByUserId: null, createdAt: now, updatedAt: now,
  } as Job;
  const controller = new AbortController();

  await runUploadedDocumentIngestJob(job, { workerId: "worker-1", signal: controller.signal, updateProgress: vi.fn(async () => undefined) });

  expect(mocks.parseDocument).toHaveBeenCalledWith(expect.objectContaining({
    format: "png",
    fileName: "sample.png",
    languageHint: "ar",
  }));
});

it("persists OCR engine provenance on chunks and OCR status counts on the version", async () => {
  mocks.parseDocument.mockResolvedValueOnce({
    status: "partially_parsed",
    sections: [{
      sectionKey: "ocr-region-2",
      kind: "ocr_region",
      text: "نص موثوق",
      metadata: { bbox: { x0: 3, y0: 4, x1: 50, y1: 24 }, confidence: 88, language: "ara" },
    }],
    warnings: [{ code: "low_confidence", message: "One OCR region was below threshold." }],
    documentMetadata: {
      format: "png",
      extractedTextChars: 8,
      ocr: {
        engine: "tesseract.js",
        engineVersion: "7.0.0",
        language: "ara",
        confidence: 76,
        status: "partially_parsed",
        acceptedRegionCount: 1,
        rejectedRegionCount: 1,
      },
    },
  });
  mocks.sqlRun.mockClear();
  mocks.updateVersionParseState.mockClear();
  const now = new Date().toISOString();
  const job = {
    id: "job-ocr", workspaceId: "workspace-1", projectId: "project-1", jobType: "uploaded_document_ingest",
    payload: { projectId: "project-1", versionId: "version-1" }, dedupeKey: null, status: "pending",
    priority: 0, attempts: 0, maxAttempts: 3, lockedBy: null, lockedAt: null, runAfter: now,
    errorMessage: null, createdByUserId: null, createdAt: now, updatedAt: now,
  } as Job;
  const controller = new AbortController();

  const result = await runUploadedDocumentIngestJob(job, {
    workerId: "worker-ocr",
    signal: controller.signal,
    updateProgress: vi.fn(async () => undefined),
  });

  expect(result).toMatchObject({ outcome: "partially_parsed", chunkCount: 1, parseStatus: "partially_parsed" });
  expect(mocks.updateVersionParseState).toHaveBeenLastCalledWith(expect.objectContaining({
    parseStatus: "partially_parsed",
    chunkCount: 1,
    metadata: expect.objectContaining({
      detectedMimeType: "image/png",
      uploadByteLength: 5,
      image: { width: 100, height: 50 },
      ocr: expect.objectContaining({ acceptedRegionCount: 1, rejectedRegionCount: 1, status: "partially_parsed" }),
    }),
  }));
  const sqlCalls = mocks.sqlRun.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
  const chunkInsert = sqlCalls.find(([sql]) => sql.includes("INSERT INTO document_chunks"));
  expect(JSON.parse(chunkInsert?.[1]?.metadataJson as string)).toEqual(expect.objectContaining({
    origin: "ocr_text",
    engine: "tesseract.js",
    engineVersion: "7.0.0",
    language: "ara",
    confidence: 88,
    bbox: { x0: 3, y0: 4, x1: 50, y1: 24 },
    sectionKind: "ocr_region",
  }));
});

it.each([
  ["no_text", [], [{ code: "no_extractable_text", message: "No text found." }]],
  ["low_confidence", [], [{ code: "low_confidence", message: "All OCR regions were below threshold." }]],
] as const)("persists OCR %s diagnostics without creating chunks", async (ocrStatus, sections, warnings) => {
  mocks.lifecycleStatus = "active";
  mocks.parseDocument.mockResolvedValueOnce({
    status: "empty",
    sections,
    warnings,
    documentMetadata: {
      format: "png", extractedTextChars: 0,
      ocr: { engine: "tesseract.js", engineVersion: "7.0.0", language: "ara", confidence: 20,
        status: ocrStatus, acceptedRegionCount: 0, rejectedRegionCount: ocrStatus === "low_confidence" ? 1 : 0 },
    },
  });
  mocks.sqlRun.mockClear();
  mocks.updateVersionParseState.mockClear();
  const now = new Date().toISOString();
  const job = { id: `job-${ocrStatus}`, workspaceId: "workspace-1", projectId: "project-1", jobType: "uploaded_document_ingest",
    payload: { projectId: "project-1", versionId: "version-1" }, dedupeKey: null, status: "pending", priority: 0,
    attempts: 0, maxAttempts: 3, lockedBy: null, lockedAt: null, runAfter: now, errorMessage: null,
    createdByUserId: null, createdAt: now, updatedAt: now } as Job;
  const controller = new AbortController();

  const result = await runUploadedDocumentIngestJob(job, { workerId: "worker", signal: controller.signal, updateProgress: vi.fn(async () => undefined) });

  expect(result).toMatchObject({ outcome: "parsed", chunkCount: 0, parseStatus: "parsed" });
  expect((mocks.sqlRun.mock.calls as unknown as Array<[string]>).some(([sql]) => sql.includes("INSERT INTO document_chunks"))).toBe(false);
  expect(mocks.updateVersionParseState).toHaveBeenLastCalledWith(expect.objectContaining({
    chunkCount: 0,
    metadata: expect.objectContaining({ ocr: expect.objectContaining({ status: ocrStatus, acceptedRegionCount: 0 }) }),
  }));
});

it("leaves an archived OCR document untouched without parsing or replacing chunks", async () => {
  mocks.lifecycleStatus = "archived";
  mocks.parseDocument.mockClear();
  mocks.sqlRun.mockClear();
  mocks.updateVersionParseState.mockClear();
  const now = new Date().toISOString();
  const job = { id: "job-archived", workspaceId: "workspace-1", projectId: "project-1", jobType: "uploaded_document_ingest",
    payload: { projectId: "project-1", versionId: "version-1" }, dedupeKey: null, status: "pending", priority: 0,
    attempts: 0, maxAttempts: 3, lockedBy: null, lockedAt: null, runAfter: now, errorMessage: null,
    createdByUserId: null, createdAt: now, updatedAt: now } as Job;
  const controller = new AbortController();

  await expect(runUploadedDocumentIngestJob(job, { workerId: "worker", signal: controller.signal, updateProgress: vi.fn(async () => undefined) }))
    .resolves.toMatchObject({ outcome: "skipped_archived", chunkCount: 0 });
  expect(mocks.parseDocument).not.toHaveBeenCalled();
  expect(mocks.sqlRun).not.toHaveBeenCalled();
  expect(mocks.updateVersionParseState).not.toHaveBeenCalled();
  mocks.lifecycleStatus = "active";
});
