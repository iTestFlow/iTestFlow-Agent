import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveDocumentMutationScope: vi.fn(),
  getProjectSourceDocument: vi.fn(),
  updateProjectSourceDocumentMetadata: vi.fn(),
  withTransaction: vi.fn(),
  markProjectKnowledgeDocumentSourceDrift: vi.fn(),
  refreshProjectContextSearchIndex: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock("../document-route-helpers", () => ({
  documentAuthOrErrorResponse: (error: unknown, fallback: string) => new Response(
    JSON.stringify({ error: error instanceof Error ? error.message : fallback }),
    { status: 500, headers: { "content-type": "application/json" } },
  ),
  parseDocumentScopeParam: vi.fn(),
  resolveDocumentReadScope: vi.fn(),
  resolveDocumentMutationScope: mocks.resolveDocumentMutationScope,
}));

vi.mock("@/modules/documents/project-source-documents.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/documents/project-source-documents.service")>();
  return {
    ...actual,
    getProjectSourceDocument: mocks.getProjectSourceDocument,
    updateProjectSourceDocumentMetadata: mocks.updateProjectSourceDocumentMetadata,
  };
});

vi.mock("@/modules/shared/infrastructure/database/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/shared/infrastructure/database/db")>();
  return { ...actual, withTransaction: mocks.withTransaction };
});

vi.mock("@/modules/rag/context-chatbot-retrieval.service", () => ({
  refreshProjectContextSearchIndex: mocks.refreshProjectContextSearchIndex,
}));

vi.mock("@/modules/rag/project-knowledge-draft.service", () => ({
  markProjectKnowledgeDocumentSourceDrift: mocks.markProjectKnowledgeDocumentSourceDrift,
}));

vi.mock("@/modules/audit/audit.service", () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

import { PATCH } from "./route";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Project One",
  azureOrganizationUrl: "https://dev.azure.com/example",
};

const originalDocument = {
  id: "document-1",
  ...scope,
  documentName: "Original policy",
  description: "Before",
  tags: ["policy"],
  languageHint: "en",
  documentKind: "document" as const,
  sourceConnector: "upload" as const,
  externalReference: null,
  currentVersionId: "version-1",
  lifecycleStatus: "active" as const,
  archivedAt: null,
  archivedBy: null,
  archivedReason: null,
  createdBy: "owner-1",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function patchRequest(body: unknown) {
  return new Request("http://localhost/api/context/documents/document-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH context document metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates a title with chunks, FTS, and knowledge drift in one transaction", async () => {
    const client = { id: "transaction-client" };
    const updatedDocument = { ...originalDocument, documentName: "Release policy" };
    const impact = { documentId: originalDocument.id, totalEntries: 2, entries: [] };
    mocks.resolveDocumentMutationScope.mockResolvedValue({
      ctx: { userId: "owner-1", workspace: { id: scope.workspaceId } },
      scope,
    });
    mocks.withTransaction.mockImplementation(async (callback: (value: unknown) => unknown) => callback(client));
    mocks.getProjectSourceDocument.mockResolvedValue(originalDocument);
    mocks.updateProjectSourceDocumentMetadata.mockResolvedValue(updatedDocument);
    mocks.markProjectKnowledgeDocumentSourceDrift.mockResolvedValue(impact);
    mocks.refreshProjectContextSearchIndex.mockResolvedValue(undefined);

    const response = await PATCH(patchRequest({
      scope,
      documentName: "Release policy",
      description: "Before",
      tags: ["policy"],
      languageHint: "en",
    }), { params: Promise.resolve({ documentId: originalDocument.id }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      document: { id: originalDocument.id, documentName: "Release policy" },
      titleChanged: true,
      impact: { totalEntries: 2 },
    });
    expect(mocks.getProjectSourceDocument).toHaveBeenCalledWith({
      scope,
      documentId: originalDocument.id,
      client,
      forUpdate: true,
    });
    expect(mocks.updateProjectSourceDocumentMetadata).toHaveBeenCalledWith({
      scope,
      documentId: originalDocument.id,
      client,
      documentName: "Release policy",
      description: "Before",
      tags: ["policy"],
      languageHint: "en",
    });
    expect(mocks.markProjectKnowledgeDocumentSourceDrift).toHaveBeenCalledWith({
      scope,
      documentId: originalDocument.id,
      action: "metadata_updated",
      client,
    });
    expect(mocks.refreshProjectContextSearchIndex).toHaveBeenCalledWith({ scope }, client);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: "documents.metadata_updated",
      details: expect.objectContaining({ titleChanged: true, impactedKnowledgeEntries: 2 }),
    }));
  });

  it("keeps descriptive-only edits out of the retrieval and knowledge lifecycle", async () => {
    const client = { id: "transaction-client" };
    const updatedDocument = { ...originalDocument, description: "Clarified" };
    mocks.resolveDocumentMutationScope.mockResolvedValue({
      ctx: { userId: "owner-1", workspace: { id: scope.workspaceId } },
      scope,
    });
    mocks.withTransaction.mockImplementation(async (callback: (value: unknown) => unknown) => callback(client));
    mocks.getProjectSourceDocument.mockResolvedValue(originalDocument);
    mocks.updateProjectSourceDocumentMetadata.mockResolvedValue(updatedDocument);

    const response = await PATCH(patchRequest({ scope, description: "Clarified" }), {
      params: Promise.resolve({ documentId: originalDocument.id }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ titleChanged: false, impact: null });
    expect(mocks.updateProjectSourceDocumentMetadata).toHaveBeenCalledWith({
      scope,
      documentId: originalDocument.id,
      client,
      description: "Clarified",
    });
    expect(mocks.markProjectKnowledgeDocumentSourceDrift).not.toHaveBeenCalled();
    expect(mocks.refreshProjectContextSearchIndex).not.toHaveBeenCalled();
  });

  it("rejects an empty metadata patch before resolving authorization", async () => {
    const response = await PATCH(patchRequest({ scope }), {
      params: Promise.resolve({ documentId: originalDocument.id }),
    });

    expect(response.status).toBe(400);
    expect(mocks.resolveDocumentMutationScope).not.toHaveBeenCalled();
  });
});
