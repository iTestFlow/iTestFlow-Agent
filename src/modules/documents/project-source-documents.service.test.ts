import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sqlGet: vi.fn(),
  sqlRun: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock("@/modules/shared/infrastructure/database/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/modules/shared/infrastructure/database/db")>();
  return {
    ...actual,
    nowIso: () => "2026-08-04T12:00:00.000Z",
    sqlGet: mocks.sqlGet,
    sqlRun: mocks.sqlRun,
    withTransaction: mocks.withTransaction,
  };
});

import { updateProjectSourceDocumentMetadata } from "./project-source-documents.service";

const scope = {
  workspaceId: "workspace-1",
  projectId: "project-1",
  azureProjectId: "azure-project-1",
  azureProjectName: "Project One",
  azureOrganizationUrl: "https://dev.azure.com/example",
};

function documentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "document-1",
    workspace_id: scope.workspaceId,
    project_id: scope.projectId,
    azure_project_id: scope.azureProjectId,
    azure_project_name: scope.azureProjectName,
    azure_organization_url: scope.azureOrganizationUrl,
    document_name: "Original title",
    description: null,
    tags_json: "[\"policy\"]",
    language_hint: null,
    document_kind: "document",
    source_connector: "upload",
    external_reference: null,
    current_version_id: "version-1",
    lifecycle_status: "active",
    archived_at: null,
    archived_by: null,
    archived_reason: null,
    created_by: "owner-1",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("updateProjectSourceDocumentMetadata", () => {
  const client = { id: "transaction-client" } as never;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sqlRun.mockResolvedValue(undefined);
  });

  it("renames every uploaded-document chunk in the caller's transaction", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce(documentRow())
      .mockResolvedValueOnce(documentRow({ document_name: "Release policy" }));

    const document = await updateProjectSourceDocumentMetadata({
      scope,
      documentId: "document-1",
      documentName: "Release policy",
      client,
    });

    expect(document.documentName).toBe("Release policy");
    expect(mocks.sqlRun).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE document_chunks"),
      expect.objectContaining({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        documentId: "document-1",
        documentName: "Release policy",
      }),
      client,
    );
    expect(mocks.sqlRun.mock.calls[0]?.[0]).toContain("source_type = 'uploaded_document'");
  });

  it("does not rewrite chunks when a non-title metadata field changes", async () => {
    mocks.sqlGet
      .mockResolvedValueOnce(documentRow())
      .mockResolvedValueOnce(documentRow({ description: "Clarified policy context" }));

    await updateProjectSourceDocumentMetadata({
      scope,
      documentId: "document-1",
      description: "Clarified policy context",
      client,
    });

    expect(mocks.sqlRun).not.toHaveBeenCalled();
  });
});
