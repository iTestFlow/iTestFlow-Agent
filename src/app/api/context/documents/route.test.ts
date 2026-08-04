import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkflowContext: vi.fn(),
  resolveProjectScope: vi.fn(),
  listProjectSourceDocuments: vi.fn(),
  getProjectSourceDocumentVersion: vi.fn(),
  sqlGet: vi.fn(),
  sqlAll: vi.fn(),
}));

vi.mock("@/modules/credentials/scoped-resolution.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/credentials/scoped-resolution.service")>();
  return { ...actual, requireWorkflowContext: mocks.requireWorkflowContext };
});
vi.mock("@/modules/projects/workspace-projects.service", () => ({
  resolveProjectScope: mocks.resolveProjectScope,
}));
vi.mock("@/modules/documents/project-source-documents.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/documents/project-source-documents.service")>();
  return {
    ...actual,
    listProjectSourceDocuments: mocks.listProjectSourceDocuments,
    getProjectSourceDocumentVersion: mocks.getProjectSourceDocumentVersion,
  };
});
vi.mock("@/modules/shared/infrastructure/database/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/shared/infrastructure/database/db")>();
  return { ...actual, sqlGet: mocks.sqlGet, sqlAll: mocks.sqlAll };
});

import { GET } from "./route";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Project One",
  azureOrganizationUrl: "https://dev.azure.com/example",
};

const document = {
  id: "document-1",
  ...scope,
  documentName: "Policy",
  description: null,
  tags: [],
  languageHint: null,
  documentKind: "document" as const,
  sourceConnector: "upload" as const,
  externalReference: null,
  currentVersionId: "version-1",
  lifecycleStatus: "active" as const,
  archivedAt: null,
  archivedBy: null,
  archivedReason: null,
  createdBy: "owner-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const version = {
  id: "version-1",
  documentId: "document-1",
  ...scope,
  versionNumber: 1,
  storageBackend: "local_fs" as const,
  storageKey: "ws/workspace-1/aa/hash",
  originalFileName: "policy.pdf",
  mimeType: "application/pdf",
  fileFormat: "pdf" as const,
  byteSize: 10,
  contentHash: "a".repeat(64),
  parseStatus: "parsed" as const,
  parseError: null,
  parseWarnings: [],
  parseRecipeVersion: "1.0.0",
  chunkCount: 1,
  metadata: {},
  uploadedBy: "owner-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("GET context documents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireWorkflowContext.mockResolvedValue({ userId: "member-1", workspace: { id: "workspace-1" } });
    mocks.resolveProjectScope.mockResolvedValue(scope);
    mocks.listProjectSourceDocuments.mockResolvedValue([document]);
    mocks.getProjectSourceDocumentVersion.mockResolvedValue(version);
    mocks.sqlGet.mockResolvedValue({ total_count: "1" });
    mocks.sqlAll.mockResolvedValue([{ document_id: document.id, version_count: "1" }]);
  });

  it("rejects malformed scope before any scoped service call", async () => {
    const response = await GET(new Request("http://localhost/api/context/documents?scope=bad-json"));
    expect(response.status).toBe(400);
    expect(mocks.requireWorkflowContext).not.toHaveBeenCalled();
  });

  it("returns enriched, scoped document rows with stable pagination", async () => {
    const url = new URL("http://localhost/api/context/documents");
    url.searchParams.set("scope", JSON.stringify(scope));
    url.searchParams.set("page", "1");
    url.searchParams.set("pageSize", "25");
    const response = await GET(new Request(url));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      totalCount: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
      documents: [{ document: { id: document.id }, currentVersion: { id: version.id }, versionCount: 1 }],
    });
    expect(mocks.resolveProjectScope).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: { id: "workspace-1" } }),
      scope,
    );
  });
});
