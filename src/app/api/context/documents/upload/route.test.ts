import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentParseError } from "@/modules/documents/parsed-document.types";

const mocks = vi.hoisted(() => ({
  createReadStream: vi.fn(),
  readFile: vi.fn(),
  documentUploadRateLimitResponse: vi.fn(),
  documentUploadSessionResponse: vi.fn(),
  markDocumentVersionEnqueueFailed: vi.fn(),
  parseDocumentUploadFields: vi.fn(),
  resolveDocumentMutationScope: vi.fn(),
  safeDocumentDownloadName: vi.fn((name: string) => name),
  displayDocumentNameFromFileName: vi.fn(() => "Screenshot"),
  streamDocumentUploadMultipart: vi.fn(),
  removeStreamedDocumentMultipart: vi.fn(),
  validateDocumentUpload: vi.fn(),
  getDocumentStorageBackend: vi.fn(),
  createDocumentWithVersion: vi.fn(),
  hasHealthyWorkerCapability: vi.fn(),
  enqueueUploadedDocumentIngestJob: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("node:fs", () => ({ createReadStream: mocks.createReadStream }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("../document-route-helpers", () => ({
  displayDocumentNameFromFileName: mocks.displayDocumentNameFromFileName,
  documentAuthOrErrorResponse: (error: unknown, fallback: string) => new Response(
    JSON.stringify({ error: error instanceof Error ? error.message : fallback }),
    { status: 500, headers: { "content-type": "application/json" } },
  ),
  documentUploadRateLimitResponse: mocks.documentUploadRateLimitResponse,
  documentUploadSessionResponse: mocks.documentUploadSessionResponse,
  markDocumentVersionEnqueueFailed: mocks.markDocumentVersionEnqueueFailed,
  parseDocumentUploadFields: mocks.parseDocumentUploadFields,
  resolveDocumentMutationScope: mocks.resolveDocumentMutationScope,
  safeDocumentDownloadName: mocks.safeDocumentDownloadName,
}));
vi.mock("@/modules/documents/streaming-multipart-upload", () => ({
  streamDocumentUploadMultipart: mocks.streamDocumentUploadMultipart,
  removeStreamedDocumentMultipart: mocks.removeStreamedDocumentMultipart,
}));
vi.mock("@/modules/documents/document-upload-validation", async () => ({
  ...await vi.importActual<typeof import("@/modules/documents/document-upload-validation")>(
    "@/modules/documents/document-upload-validation",
  ),
  validateDocumentUpload: mocks.validateDocumentUpload,
}));
vi.mock("@/modules/documents/document-storage.service", () => ({
  getDocumentStorageBackend: mocks.getDocumentStorageBackend,
}));
vi.mock("@/modules/documents/project-source-documents.service", () => ({
  createDocumentWithVersion: mocks.createDocumentWithVersion,
}));
vi.mock("@/modules/jobs/worker-registry.service", () => ({
  hasHealthyWorkerCapability: mocks.hasHealthyWorkerCapability,
}));
vi.mock("@/modules/jobs/uploaded-document-jobs.service", () => ({
  DOCUMENT_INGEST_UNAVAILABLE_CODE: "document_ingest_unavailable",
  DOCUMENT_INGEST_UNAVAILABLE_MESSAGE: "Document ingestion is unavailable.",
  enqueueUploadedDocumentIngestJob: mocks.enqueueUploadedDocumentIngestJob,
  isDocumentIngestUnavailableError: () => false,
  UPLOADED_DOCUMENT_INGEST: "uploaded_document_ingest",
}));
vi.mock("@/modules/audit/audit.service", () => ({ writeAuditLog: mocks.writeAuditLog }));

import { POST } from "./route";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Project One",
  azureOrganizationUrl: "https://dev.azure.com/example",
};

describe("POST context document upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.documentUploadRateLimitResponse.mockResolvedValue(null);
    mocks.documentUploadSessionResponse.mockResolvedValue(null);
    mocks.parseDocumentUploadFields.mockReturnValue({ success: true, data: { scope, tags: [] } });
    mocks.resolveDocumentMutationScope.mockResolvedValue({
      ctx: { userId: "owner-1", workspace: { id: scope.workspaceId } },
      scope,
    });
    mocks.streamDocumentUploadMultipart.mockResolvedValue({
      fields: {},
      files: [{
        tempPath: "C:/temp/image.upload",
        originalFileName: "image.png",
        mimeType: "image/png",
        byteSize: 5,
        contentSha256: "a".repeat(64),
      }],
    });
    mocks.removeStreamedDocumentMultipart.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue(Buffer.from("hello"));
    mocks.createReadStream.mockReturnValue({});
    mocks.getDocumentStorageBackend.mockReturnValue({
      kind: "local_fs",
      put: vi.fn().mockResolvedValue({ storageKey: "ws/workspace-1/aa/hash", created: true }),
    });
    mocks.hasHealthyWorkerCapability.mockResolvedValue(true);
    mocks.createDocumentWithVersion.mockResolvedValue({
      document: { id: "document-1", documentName: "Screenshot" },
      version: { id: "version-1", versionNumber: 1, byteSize: 5, fileFormat: "png" },
      duplicateContentMatches: [],
    });
    mocks.enqueueUploadedDocumentIngestJob.mockResolvedValue({ job: { id: "job-1" }, reused: false });
  });

  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ] as const)("persists the canonical %s MIME type for an initial image upload", async (format, mimeType) => {
    mocks.validateDocumentUpload.mockResolvedValue({
      format,
      detectedMimeType: mimeType,
      byteLength: 5,
      image: { width: 1, height: 1 },
    });

    const response = await POST(new Request("http://localhost/api/context/documents/upload", { method: "POST" }));

    expect(response.status).toBe(202);
    expect(mocks.createDocumentWithVersion).toHaveBeenCalledWith(expect.objectContaining({
      version: expect.objectContaining({
        mimeType,
        fileFormat: format,
        metadata: expect.objectContaining({ image: { width: 1, height: 1 } }),
      }),
    }));
  });

  it("keeps valid siblings when another file fails validation in the same request", async () => {
    const files = [
      { tempPath: "C:/temp/bad", originalFileName: "bad.png", mimeType: "image/png", byteSize: 3, contentSha256: "b".repeat(64) },
      { tempPath: "C:/temp/good", originalFileName: "good.png", mimeType: "image/png", byteSize: 4, contentSha256: "c".repeat(64) },
    ];
    mocks.streamDocumentUploadMultipart.mockResolvedValue({ fields: {}, files });
    mocks.readFile.mockResolvedValueOnce(Buffer.from("bad")).mockResolvedValueOnce(Buffer.from("good"));
    let activeValidations = 0;
    let maxActiveValidations = 0;
    mocks.validateDocumentUpload
      .mockImplementationOnce(async () => {
        activeValidations += 1;
        maxActiveValidations = Math.max(maxActiveValidations, activeValidations);
        activeValidations -= 1;
        throw new DocumentParseError({ code: "corrupted", message: "Invalid image bytes." });
      })
      .mockImplementationOnce(async () => {
        activeValidations += 1;
        maxActiveValidations = Math.max(maxActiveValidations, activeValidations);
        activeValidations -= 1;
        return { format: "png", detectedMimeType: "image/png", byteLength: 4, image: { width: 1, height: 1 } };
      });

    const response = await POST(new Request("http://localhost/api/context/documents/upload", { method: "POST" }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      uploads: [expect.objectContaining({ clientIndex: 1, versionId: "version-1" })],
      failures: [{ clientIndex: 0, fileName: "bad.png", error: "Invalid image bytes." }],
    });
    expect(maxActiveValidations).toBe(1);
    expect(mocks.createDocumentWithVersion).toHaveBeenCalledOnce();
    expect(mocks.enqueueUploadedDocumentIngestJob).toHaveBeenCalledOnce();
    expect(mocks.writeAuditLog).toHaveBeenCalledOnce();
    expect(mocks.removeStreamedDocumentMultipart).toHaveBeenCalledOnce();
  });

  it("persists a shared OCR hint only on image documents in a mixed batch", async () => {
    mocks.parseDocumentUploadFields.mockReturnValue({ success: true, data: { scope, tags: [], languageHint: "eng" } });
    mocks.streamDocumentUploadMultipart.mockResolvedValue({ fields: {}, files: [
      { tempPath: "C:/temp/image", originalFileName: "scan.png", mimeType: "image/png", byteSize: 5, contentSha256: "a".repeat(64) },
      { tempPath: "C:/temp/pdf", originalFileName: "policy.pdf", mimeType: "application/pdf", byteSize: 5, contentSha256: "b".repeat(64) },
    ] });
    mocks.readFile.mockResolvedValue(Buffer.from("hello"));
    mocks.validateDocumentUpload
      .mockResolvedValueOnce({ format: "png", detectedMimeType: "image/png", byteLength: 5, image: { width: 1, height: 1 } })
      .mockResolvedValueOnce({ format: "pdf", detectedMimeType: "application/pdf", byteLength: 5 });

    const response = await POST(new Request("http://localhost/api/context/documents/upload", { method: "POST" }));

    expect(response.status).toBe(202);
    expect(mocks.createDocumentWithVersion).toHaveBeenNthCalledWith(1, expect.objectContaining({ languageHint: "eng" }));
    expect(mocks.createDocumentWithVersion).toHaveBeenNthCalledWith(2, expect.objectContaining({ languageHint: undefined }));
  });

  it("does not expose operational storage errors in per-file failures", async () => {
    mocks.validateDocumentUpload.mockResolvedValue({ format: "png", detectedMimeType: "image/png", byteLength: 5, image: { width: 1, height: 1 } });
    mocks.getDocumentStorageBackend.mockReturnValue({ kind: "local_fs", put: vi.fn().mockRejectedValue(new Error("postgres://secret-token@private-host")) });

    const response = await POST(new Request("http://localhost/api/context/documents/upload", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.failures[0].error).toBe("Upload failed for this file.");
    expect(JSON.stringify(body)).not.toContain("secret-token");
  });
});
