import { createHash } from "node:crypto";

import { afterAll, beforeAll, expect, it } from "vitest";

import { resetDatabaseForTests, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  archiveProjectSourceDocument,
  createDocumentWithVersion,
  createVersionForDocument,
  findProjectSourceDocumentContentMatches,
  getProjectSourceDocument,
  getProjectSourceDocumentVersion,
  getProjectSourceDocumentWithVersions,
  listProjectSourceDocumentVersions,
  listProjectSourceDocuments,
  ProjectSourceDocumentLifecycleError,
  restoreProjectSourceDocument,
  type CreateProjectSourceDocumentVersionInput,
} from "./project-source-documents.service";

// Per-run identifiers: this suite shares the database with other suites/agents, so
// every row it writes is keyed under these unique workspace/project ids.
const WS = uniqueTestId("ws_psdoc");
const ORG = `https://dev.azure.com/${WS}`;
const PROJECT = uniqueTestId("az_psdoc");

const scope: ProjectScope = {
  projectId: PROJECT,
  azureProjectId: PROJECT,
  azureProjectName: "Source Documents Project",
  azureOrganizationUrl: ORG,
  workspaceId: WS,
};

function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function versionInput(
  overrides: Partial<CreateProjectSourceDocumentVersionInput> = {},
): CreateProjectSourceDocumentVersionInput {
  return {
    storageKey: `ws/${WS}/aa/${uniqueTestId("hash")}`,
    originalFileName: "notes.txt",
    mimeType: "text/plain",
    fileFormat: "txt",
    byteSize: 128,
    contentHash: sha256Hex(uniqueTestId("body")),
    uploadedBy: uniqueTestId("user"),
    ...overrides,
  };
}

describeDb("project source documents service (DB-backed)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: WS, orgUrl: ORG });
    await seedProject({
      workspaceId: WS,
      orgUrl: ORG,
      azureProjectId: PROJECT,
      azureProjectName: "Source Documents Project",
    });
  });

  afterAll(async () => {
    // The document/current-version pair is a deferred-FK cycle: null the
    // pointer before deleting versions, then documents, so neither RESTRICT
    // FK trips mid-cleanup. Only then can cleanupFixtures drop `projects`.
    await sqlRun(`UPDATE project_source_documents SET current_version_id = NULL WHERE workspace_id = @ws`, { ws: WS });
    await sqlRun(`DELETE FROM project_source_document_versions WHERE workspace_id = @ws`, { ws: WS });
    await sqlRun(`DELETE FROM project_source_documents WHERE workspace_id = @ws`, { ws: WS });
    await cleanupFixtures({ workspaceIds: [WS], userIds: [] });
    await resetDatabaseForTests();
  });

  it("creates a document with its first version and finds/lists it back", async () => {
    const documentName = `Doc ${uniqueTestId("name")}`;
    const createdBy = uniqueTestId("user");
    const result = await createDocumentWithVersion({
      scope,
      documentName,
      createdBy,
      version: versionInput(),
    });

    expect(result.document.documentName).toBe(documentName);
    expect(result.document.lifecycleStatus).toBe("active");
    expect(result.document.currentVersionId).toBe(result.version.id);
    expect(result.version.versionNumber).toBe(1);
    expect(result.duplicateContentMatches).toEqual([]);

    const found = await getProjectSourceDocument({ scope, documentId: result.document.id });
    expect(found).toEqual(result.document);

    const list = await listProjectSourceDocuments({ scope });
    expect(list.some((doc) => doc.id === result.document.id)).toBe(true);

    const foundVersion = await getProjectSourceDocumentVersion({ scope, versionId: result.version.id });
    expect(foundVersion).toEqual(result.version);

    const withVersions = await getProjectSourceDocumentWithVersions({ scope, documentId: result.document.id });
    expect(withVersions?.versions).toHaveLength(1);
    expect(withVersions?.versions[0]?.id).toBe(result.version.id);
  });

  it("createVersionForDocument bumps version_number and advances current_version_id", async () => {
    const created = await createDocumentWithVersion({
      scope,
      documentName: `Doc ${uniqueTestId("name")}`,
      createdBy: uniqueTestId("user"),
      version: versionInput(),
    });

    const versioned = await createVersionForDocument({
      scope,
      documentId: created.document.id,
      version: versionInput(),
    });

    expect(versioned.version.versionNumber).toBe(2);
    expect(versioned.document.currentVersionId).toBe(versioned.version.id);

    const versions = await listProjectSourceDocumentVersions({ scope, documentId: created.document.id });
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);

    const current = await getProjectSourceDocument({ scope, documentId: created.document.id });
    expect(current?.currentVersionId).toBe(versioned.version.id);
  });

  it("keeps document_kind aligned with the current version format", async () => {
    const created = await createDocumentWithVersion({
      scope,
      documentName: `Image ${uniqueTestId("name")}`,
      createdBy: uniqueTestId("user"),
      version: versionInput({
        originalFileName: "scan.png",
        mimeType: "image/png",
        fileFormat: "png",
      }),
    });
    expect(created.document.documentKind).toBe("image");

    const versioned = await createVersionForDocument({
      scope,
      documentId: created.document.id,
      version: versionInput(),
    });
    expect(versioned.document.documentKind).toBe("document");
    expect((await getProjectSourceDocument({ scope, documentId: created.document.id }))?.documentKind).toBe("document");
  });

  it("archive sets lifecycle_status=archived with archived_at, rejects new versions, then restore flips back", async () => {
    const created = await createDocumentWithVersion({
      scope,
      documentName: `Doc ${uniqueTestId("name")}`,
      createdBy: uniqueTestId("user"),
      version: versionInput(),
    });
    const archivedBy = uniqueTestId("user");

    const archived = await archiveProjectSourceDocument({
      scope,
      documentId: created.document.id,
      archivedBy,
      reason: "superseded",
    });
    // The chk_project_source_documents_archive_state CHECK constraint requires
    // archived_at/by/reason to be set together with lifecycle_status='archived';
    // the UPDATE succeeding at all proves the constraint held for this row.
    expect(archived.lifecycleStatus).toBe("archived");
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.archivedBy).toBe(archivedBy);
    expect(archived.archivedReason).toBe("superseded");

    // archiveProjectSourceDocument is idempotent: archiving an already-archived
    // document is a no-op that returns the existing row, not a second write.
    const archivedAgain = await archiveProjectSourceDocument({
      scope,
      documentId: created.document.id,
      archivedBy: uniqueTestId("user"),
      reason: "a different reason",
    });
    expect(archivedAgain.archivedBy).toBe(archivedBy);
    expect(archivedAgain.archivedReason).toBe("superseded");

    await expect(
      createVersionForDocument({ scope, documentId: created.document.id, version: versionInput() }),
    ).rejects.toBeInstanceOf(ProjectSourceDocumentLifecycleError);

    const restored = await restoreProjectSourceDocument({ scope, documentId: created.document.id });
    expect(restored.lifecycleStatus).toBe("active");
    expect(restored.archivedAt).toBeNull();
    expect(restored.archivedBy).toBeNull();
    expect(restored.archivedReason).toBeNull();

    // restoreProjectSourceDocument is likewise idempotent.
    const restoredAgain = await restoreProjectSourceDocument({ scope, documentId: created.document.id });
    expect(restoredAgain.lifecycleStatus).toBe("active");

    const versioned = await createVersionForDocument({
      scope,
      documentId: created.document.id,
      version: versionInput(),
    });
    expect(versioned.version.versionNumber).toBe(2);
  });

  it("findProjectSourceDocumentContentMatches surfaces duplicate content across documents", async () => {
    const sharedHash = sha256Hex(uniqueTestId("shared-body"));
    const first = await createDocumentWithVersion({
      scope,
      documentName: `Doc ${uniqueTestId("name")}`,
      createdBy: uniqueTestId("user"),
      version: versionInput({ contentHash: sharedHash }),
    });

    const second = await createDocumentWithVersion({
      scope,
      documentName: `Doc ${uniqueTestId("name")}`,
      createdBy: uniqueTestId("user"),
      version: versionInput({ contentHash: sharedHash }),
    });
    // Duplicate detection at creation time only sees rows that existed BEFORE
    // this transaction's own insert, so the second document's own new version
    // is not counted as its own match -- only the first document is returned.
    expect(second.duplicateContentMatches).toHaveLength(1);
    expect(second.duplicateContentMatches[0]?.document.id).toBe(first.document.id);

    const matches = await findProjectSourceDocumentContentMatches({ scope, contentHash: sharedHash });
    expect(matches.map((match) => match.document.id).sort()).toEqual(
      [first.document.id, second.document.id].sort(),
    );
  });

  it("rejects a second version row with a duplicate (document_id, version_number)", async () => {
    // The service itself always auto-increments version_number, so the only way
    // to exercise uq_project_source_document_versions_number is a direct insert
    // that reuses an existing (document_id, version_number) pair.
    const created = await createDocumentWithVersion({
      scope,
      documentName: `Doc ${uniqueTestId("name")}`,
      createdBy: uniqueTestId("user"),
      version: versionInput(),
    });

    const now = new Date().toISOString();
    await expect(
      sqlRun(
        `INSERT INTO project_source_document_versions (
           id, document_id, workspace_id, project_id, azure_project_id,
           version_number, storage_backend, storage_key, original_file_name,
           mime_type, file_format, byte_size, content_hash, parse_status,
           parse_warnings_json, chunk_count, metadata_json, uploaded_by, created_at, updated_at
         ) VALUES (
           @id, @documentId, @workspaceId, @projectId, @azureProjectId,
           1, 'local_fs', @storageKey, 'duplicate.txt',
           'text/plain', 'txt', 64, @contentHash, 'pending',
           '[]', 0, '{}', @uploadedBy, @now, @now
         )`,
        {
          id: uniqueTestId("psdocv_dupe"),
          documentId: created.document.id,
          workspaceId: WS,
          projectId: PROJECT,
          azureProjectId: PROJECT,
          storageKey: `ws/${WS}/bb/${uniqueTestId("hash")}`,
          contentHash: sha256Hex(uniqueTestId("dupe-body")),
          uploadedBy: uniqueTestId("user"),
          now,
        },
      ),
    ).rejects.toThrow();
  });
});
