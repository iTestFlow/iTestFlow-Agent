import { Readable } from "node:stream";

import { expect, it, vi } from "vitest";

import { DocumentParseError } from "@/modules/documents/parsed-document.types";
import type { Job } from "./job-queue.service";

const mocks = vi.hoisted(() => ({
  parseDocument: vi.fn(),
  updateVersionParseState: vi.fn(async () => undefined),
  writeAuditLog: vi.fn(),
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
  }),
  getProjectSourceDocument: async () => ({
    id: "document-1", documentName: "Arabic scan", languageHint: "ar", lifecycleStatus: "active",
  }),
  updateVersionParseState: mocks.updateVersionParseState,
}));
vi.mock("@/modules/documents/document-upload-validation", () => ({ getDocumentMaxUploadBytes: () => 1024 }));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock("@/modules/shared/infrastructure/database/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/shared/infrastructure/database/db")>()),
  sqlGet: async () => ({ azure_project_id: "azure-1", azure_project_name: "Project", azure_organization_url: "https://dev.azure.com/org" }),
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
