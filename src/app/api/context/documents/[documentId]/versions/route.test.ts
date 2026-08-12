import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createReadStream: vi.fn(),
  readFile: vi.fn(),
  documentUploadRateLimitResponse: vi.fn(),
  documentUploadSessionResponse: vi.fn(),
  markDocumentVersionEnqueueFailed: vi.fn(),
  parseDocumentUploadFields: vi.fn(),
  resolveDocumentMutationScope: vi.fn(),
  safeDocumentDownloadName: vi.fn((name: string) => name),
  streamDocumentUploadMultipart: vi.fn(),
  removeStreamedDocumentMultipart: vi.fn(),
  validateDocumentUpload: vi.fn(),
  getDocumentStorageBackend: vi.fn(),
  getProjectSourceDocument: vi.fn(),
  createVersionForDocument: vi.fn(),
  hasHealthyWorkerCapability: vi.fn(),
  enqueueUploadedDocumentIngestJob: vi.fn(),
  withTransaction: vi.fn(),
  markProjectKnowledgeDocumentSourceDrift: vi.fn(),
  refreshProjectContextSearchIndex: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("node:fs", () => ({ createReadStream: mocks.createReadStream }));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));

vi.mock("../../document-route-helpers", () => ({
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
vi.mock("@/modules/documents/document-upload-validation", () => ({
  canonicalDocumentMimeType: (format: string) => ({
    pdf: "application/pdf",
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
  })[format],
  validateDocumentUpload: mocks.validateDocumentUpload,
}));
vi.mock("@/modules/documents/document-storage.service", () => ({
  getDocumentStorageBackend: mocks.getDocumentStorageBackend,
}));
vi.mock("@/modules/documents/project-source-documents.service", () => ({
  createVersionForDocument: mocks.createVersionForDocument,
  getProjectSourceDocument: mocks.getProjectSourceDocument,
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
vi.mock("@/modules/shared/infrastructure/database/db", () => ({
  withTransaction: mocks.withTransaction,
}));
vi.mock("@/modules/rag/project-knowledge-draft.service", () => ({
  markProjectKnowledgeDocumentSourceDrift: mocks.markProjectKnowledgeDocumentSourceDrift,
}));
vi.mock("@/modules/rag/context-chatbot-retrieval.service", () => ({
  refreshProjectContextSearchIndex: mocks.refreshProjectContextSearchIndex,
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

describe("POST context document version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const client = { id: "transaction-client" };
    mocks.documentUploadRateLimitResponse.mockResolvedValue(null);
    mocks.documentUploadSessionResponse.mockResolvedValue(null);
    mocks.markDocumentVersionEnqueueFailed.mockResolvedValue(undefined);
    mocks.parseDocumentUploadFields.mockReturnValue({ success: true, data: { scope, tags: [] } });
    mocks.resolveDocumentMutationScope.mockResolvedValue({
      ctx: { userId: "owner-1", workspace: { id: scope.workspaceId } },
      scope,
    });
    mocks.streamDocumentUploadMultipart.mockResolvedValue({
      fields: {},
      files: [{
        tempPath: "C:/temp/replacement.pdf",
        originalFileName: "replacement.pdf",
        mimeType: "application/pdf",
        byteSize: 5,
        contentSha256: "a".repeat(64),
      }],
    });
    mocks.removeStreamedDocumentMultipart.mockResolvedValue(undefined);
    mocks.readFile.mockResolvedValue(Buffer.from("hello"));
    mocks.createReadStream.mockReturnValue({});
    mocks.validateDocumentUpload.mockResolvedValue({
      format: "pdf",
      detectedMimeType: "application/pdf",
      byteLength: 5,
    });
    mocks.getDocumentStorageBackend.mockReturnValue({
      kind: "local_fs",
      put: vi.fn().mockResolvedValue({ storageKey: "ws/workspace-1/aa/hash", created: true }),
    });
    mocks.getProjectSourceDocument.mockResolvedValue({ id: "document-1", documentName: "Policy" });
    mocks.hasHealthyWorkerCapability.mockResolvedValue(true);
    mocks.withTransaction.mockImplementation(async (callback: (transactionClient: unknown) => unknown) => callback(client));
    mocks.createVersionForDocument.mockResolvedValue({
      document: { id: "document-1", documentName: "Policy" },
      version: { id: "version-2", versionNumber: 2, byteSize: 5 },
      duplicateContentMatches: [],
    });
    mocks.markProjectKnowledgeDocumentSourceDrift.mockResolvedValue({
      documentId: "document-1",
      totalEntries: 2,
      entries: [],
    });
    mocks.refreshProjectContextSearchIndex.mockResolvedValue(undefined);
    mocks.enqueueUploadedDocumentIngestJob.mockResolvedValue({ job: { id: "job-1" }, reused: false });
  });

  it("atomically stales knowledge and refreshes FTS when advancing the current version", async () => {
    const response = await POST(new Request("http://localhost/api/context/documents/document-1/versions", { method: "POST" }), {
      params: Promise.resolve({ documentId: "document-1" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      documentId: "document-1",
      versionId: "version-2",
      jobId: "job-1",
      impact: { totalEntries: 2 },
    });
    const client = { id: "transaction-client" };
    expect(mocks.createVersionForDocument).toHaveBeenCalledWith(expect.objectContaining({
      scope,
      documentId: "document-1",
      client,
    }));
    expect(mocks.markProjectKnowledgeDocumentSourceDrift).toHaveBeenCalledWith({
      scope,
      documentId: "document-1",
      action: "replaced",
      client,
    });
    expect(mocks.refreshProjectContextSearchIndex).toHaveBeenCalledWith({ scope }, client);
    expect(mocks.enqueueUploadedDocumentIngestJob).toHaveBeenCalledWith(expect.objectContaining({
      scope,
      versionId: "version-2",
    }));
    expect(mocks.markProjectKnowledgeDocumentSourceDrift.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.enqueueUploadedDocumentIngestJob.mock.invocationCallOrder[0]);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "documents.version_uploaded",
      details: expect.objectContaining({ impactedKnowledgeEntries: 2 }),
    }));
  });

  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ] as const)("stores the canonical %s MIME type for a replacement image", async (format, mimeType) => {
    mocks.validateDocumentUpload.mockResolvedValue({
      format,
      detectedMimeType: mimeType,
      byteLength: 5,
      image: { width: 1, height: 1 },
    });

    const response = await POST(new Request("http://localhost/api/context/documents/document-1/versions", { method: "POST" }), {
      params: Promise.resolve({ documentId: "document-1" }),
    });

    expect(response.status).toBe(202);
    expect(mocks.createVersionForDocument).toHaveBeenCalledWith(expect.objectContaining({
      version: expect.objectContaining({ mimeType, fileFormat: format }),
    }));
  });

  it("rejects an unauthenticated caller before the multipart body is streamed", async () => {
    mocks.documentUploadSessionResponse.mockResolvedValue(
      new Response(JSON.stringify({ error: "Sign in to manage source documents." }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const response = await POST(new Request("http://localhost/api/context/documents/document-1/versions", { method: "POST" }), {
      params: Promise.resolve({ documentId: "document-1" }),
    });

    expect(response.status).toBe(401);
    expect(mocks.streamDocumentUploadMultipart).not.toHaveBeenCalled();
    expect(mocks.resolveDocumentMutationScope).not.toHaveBeenCalled();
  });

  it("marks the committed version parse_failed and still returns it when the ingest enqueue fails", async () => {
    mocks.enqueueUploadedDocumentIngestJob.mockRejectedValue(new Error("Job queue is unreachable."));

    const response = await POST(new Request("http://localhost/api/context/documents/document-1/versions", { method: "POST" }), {
      params: Promise.resolve({ documentId: "document-1" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      versionId: "version-2",
      jobId: null,
      job: null,
      reused: false,
      queueError: "Job queue is unreachable.",
    });
    expect(mocks.markDocumentVersionEnqueueFailed).toHaveBeenCalledWith({
      scope,
      versionId: "version-2",
      reason: "Job queue is unreachable.",
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "documents.version_uploaded",
      details: expect.objectContaining({ queueError: "Job queue is unreachable." }),
    }));
  });
});
