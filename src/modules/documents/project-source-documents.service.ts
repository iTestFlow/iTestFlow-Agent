import "server-only";

import type { PoolClient } from "pg";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  createId,
  nowIso,
  sqlAll,
  sqlGet,
  sqlRun,
  withTransaction,
} from "@/modules/shared/infrastructure/database/db";
import {
  DOCUMENT_STORAGE_BACKENDS,
  type DocumentStorageBackendKind,
} from "./storage/storage-backend.port";

export const PROJECT_SOURCE_DOCUMENT_KINDS = ["document", "image"] as const;
export type ProjectSourceDocumentKind = (typeof PROJECT_SOURCE_DOCUMENT_KINDS)[number];

export const PROJECT_SOURCE_DOCUMENT_CONNECTORS = [
  "upload",
  "sharepoint",
  "confluence",
  "drive",
  "url",
  "jira",
] as const;
export type ProjectSourceDocumentConnector = (typeof PROJECT_SOURCE_DOCUMENT_CONNECTORS)[number];

export const PROJECT_SOURCE_DOCUMENT_LIFECYCLE_STATUSES = ["active", "archived"] as const;
export type ProjectSourceDocumentLifecycleStatus = (typeof PROJECT_SOURCE_DOCUMENT_LIFECYCLE_STATUSES)[number];

export const PROJECT_SOURCE_DOCUMENT_FILE_FORMATS = [
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "txt",
  "md",
  "png",
  "jpeg",
  "webp",
] as const;
export type ProjectSourceDocumentFileFormat = (typeof PROJECT_SOURCE_DOCUMENT_FILE_FORMATS)[number];

export const PROJECT_SOURCE_DOCUMENT_PARSE_STATUSES = [
  "pending",
  "parsing",
  "parsed",
  "partially_parsed",
  "parse_failed",
] as const;
export type ProjectSourceDocumentParseStatus = (typeof PROJECT_SOURCE_DOCUMENT_PARSE_STATUSES)[number];

export type WorkspaceProjectScope = Omit<ProjectScope, "workspaceId"> & { workspaceId: string };

export type ProjectSourceDocument = {
  id: string;
  workspaceId: string;
  projectId: string;
  azureProjectId: string;
  azureProjectName: string;
  azureOrganizationUrl: string;
  documentName: string;
  description: string | null;
  tags: string[];
  languageHint: string | null;
  documentKind: ProjectSourceDocumentKind;
  sourceConnector: ProjectSourceDocumentConnector;
  externalReference: string | null;
  currentVersionId: string | null;
  lifecycleStatus: ProjectSourceDocumentLifecycleStatus;
  archivedAt: string | null;
  archivedBy: string | null;
  archivedReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSourceDocumentVersion = {
  id: string;
  documentId: string;
  workspaceId: string;
  projectId: string;
  azureProjectId: string;
  versionNumber: number;
  storageBackend: DocumentStorageBackendKind;
  storageKey: string;
  originalFileName: string;
  mimeType: string;
  fileFormat: ProjectSourceDocumentFileFormat;
  byteSize: number;
  contentHash: string;
  parseStatus: ProjectSourceDocumentParseStatus;
  parseError: string | null;
  parseWarnings: string[];
  parseRecipeVersion: string | null;
  chunkCount: number;
  metadata: Record<string, unknown>;
  uploadedBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectSourceDocumentContentMatch = {
  document: Pick<ProjectSourceDocument, "id" | "documentName" | "lifecycleStatus" | "currentVersionId">;
  version: Pick<ProjectSourceDocumentVersion, "id" | "versionNumber" | "contentHash" | "createdAt">;
};

export type ProjectSourceDocumentChunk = {
  id: string;
  documentId: string;
  sourceDocumentVersionId: string | null;
  documentName: string | null;
  documentType: string | null;
  section: string | null;
  pageNumber: number | null;
  chunkIndex: number;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateProjectSourceDocumentVersionInput = {
  storageBackend?: DocumentStorageBackendKind;
  /** Opaque output from StorageBackend.put; never a client filesystem path. */
  storageKey: string;
  originalFileName: string;
  mimeType: string;
  fileFormat: ProjectSourceDocumentFileFormat;
  byteSize: number;
  /** Lower-case SHA-256 of the stored original bytes. */
  contentHash: string;
  uploadedBy?: string;
  parseStatus?: ProjectSourceDocumentParseStatus;
  parseError?: string | null;
  parseWarnings?: string[];
  parseRecipeVersion?: string | null;
  chunkCount?: number;
  metadata?: Record<string, unknown>;
};

export type CreateDocumentWithVersionInput = {
  scope: ProjectScope;
  documentName: string;
  description?: string | null;
  tags?: string[];
  languageHint?: string | null;
  documentKind?: ProjectSourceDocumentKind;
  sourceConnector?: ProjectSourceDocumentConnector;
  externalReference?: string | null;
  createdBy: string;
  version: CreateProjectSourceDocumentVersionInput;
};

export type CreateDocumentWithVersionResult = {
  document: ProjectSourceDocument;
  version: ProjectSourceDocumentVersion;
  /** Informational duplicate detection; callers decide whether to proceed. */
  duplicateContentMatches: ProjectSourceDocumentContentMatch[];
};

export type CreateVersionForDocumentInput = {
  scope: ProjectScope;
  documentId: string;
  version: CreateProjectSourceDocumentVersionInput;
  /**
   * Lets a lifecycle route advance the current-version pointer atomically with
   * its derived search-index and knowledge-freshness updates. Standalone
   * callers retain the service-owned transaction.
   */
  client?: PoolClient;
};

export type CreateVersionForDocumentResult = {
  document: ProjectSourceDocument;
  version: ProjectSourceDocumentVersion;
  duplicateContentMatches: ProjectSourceDocumentContentMatch[];
};

export type UpdateProjectSourceDocumentMetadataInput = {
  scope: ProjectScope;
  documentId: string;
  documentName?: string;
  description?: string | null;
  tags?: string[];
  languageHint?: string | null;
  /**
   * Enables a lifecycle route to atomically update the logical document,
   * derived chunks, the FTS mirror, and knowledge freshness in one database
   * transaction. Standalone callers retain the service's transaction.
   */
  client?: PoolClient;
};

export type UpdateVersionParseStateInput = {
  scope: ProjectScope;
  versionId: string;
  parseStatus: ProjectSourceDocumentParseStatus;
  parseError?: string | null;
  parseWarnings?: string[];
  parseRecipeVersion?: string | null;
  chunkCount?: number;
  metadata?: Record<string, unknown>;
};

export class ProjectSourceDocumentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectSourceDocumentValidationError";
  }
}

export class ProjectSourceDocumentNotFoundError extends Error {
  constructor(entity: "document" | "version") {
    super(`The requested source ${entity} was not found in the selected project.`);
    this.name = "ProjectSourceDocumentNotFoundError";
  }
}

export class ProjectSourceDocumentLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectSourceDocumentLifecycleError";
  }
}

type ProjectSourceDocumentRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  azure_project_id: string;
  azure_project_name: string;
  azure_organization_url: string;
  document_name: string;
  description: string | null;
  tags_json: unknown;
  language_hint: string | null;
  document_kind: ProjectSourceDocumentKind;
  source_connector: ProjectSourceDocumentConnector;
  external_reference: string | null;
  current_version_id: string | null;
  lifecycle_status: ProjectSourceDocumentLifecycleStatus;
  archived_at: string | null;
  archived_by: string | null;
  archived_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

type ProjectSourceDocumentVersionRow = {
  id: string;
  document_id: string;
  workspace_id: string;
  project_id: string;
  azure_project_id: string;
  version_number: number;
  storage_backend: DocumentStorageBackendKind;
  storage_key: string;
  original_file_name: string;
  mime_type: string;
  file_format: ProjectSourceDocumentFileFormat;
  byte_size: number | string;
  content_hash: string;
  parse_status: ProjectSourceDocumentParseStatus;
  parse_error: string | null;
  parse_warnings_json: unknown;
  parse_recipe_version: string | null;
  chunk_count: number;
  metadata_json: unknown;
  uploaded_by: string;
  created_at: string;
  updated_at: string;
};

type ProjectSourceDocumentContentMatchRow = {
  document_id: string;
  document_name: string;
  lifecycle_status: ProjectSourceDocumentLifecycleStatus;
  current_version_id: string | null;
  version_id: string;
  version_number: number;
  content_hash: string;
  version_created_at: string;
};

const DOCUMENT_SELECT_COLUMNS = `
  id, workspace_id, project_id, azure_project_id, azure_project_name,
  azure_organization_url, document_name, description, tags_json, language_hint,
  document_kind, source_connector, external_reference, current_version_id,
  lifecycle_status, archived_at, archived_by, archived_reason, created_by,
  created_at, updated_at
`;

const VERSION_SELECT_COLUMNS = `
  id, document_id, workspace_id, project_id, azure_project_id, version_number,
  storage_backend, storage_key, original_file_name, mime_type, file_format,
  byte_size, content_hash, parse_status, parse_error, parse_warnings_json,
  parse_recipe_version, chunk_count, metadata_json, uploaded_by, created_at,
  updated_at
`;

/**
 * Registers a logical document and its first immutable content version in one
 * database transaction.  Store bytes with StorageBackend first, then call this
 * function with the returned opaque key; orphan-blob cleanup is deliberately a
 * later lifecycle concern rather than a reason to weaken DB atomicity here.
 */
export async function createDocumentWithVersion(input: CreateDocumentWithVersionInput): Promise<CreateDocumentWithVersionResult> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const documentInput = normalizeDocumentCreateInput(input);
  const versionInput = normalizeVersionInput(input.version, documentInput.createdBy);

  return withTransaction(async (client) => {
    const duplicateContentMatches = await findContentMatches(scope, versionInput.contentHash, client);
    const now = nowIso();
    const documentId = createId("psdoc");
    const versionId = createId("psdocv");

    const document = await sqlGet<ProjectSourceDocumentRow>(
      `
        INSERT INTO project_source_documents (
          id, workspace_id, project_id, azure_project_id, azure_project_name,
          azure_organization_url, document_name, description, tags_json,
          language_hint, document_kind, source_connector, external_reference,
          current_version_id, lifecycle_status, created_by, created_at, updated_at
        ) VALUES (
          @id, @workspaceId, @projectId, @azureProjectId, @azureProjectName,
          @azureOrganizationUrl, @documentName, @description, @tagsJson,
          @languageHint, @documentKind, @sourceConnector, @externalReference,
          NULL, 'active', @createdBy, @now, @now
        )
        RETURNING ${DOCUMENT_SELECT_COLUMNS}
      `,
      {
        id: documentId,
        ...scopeParams(scope),
        ...documentInput,
        tagsJson: JSON.stringify(documentInput.tags),
        now,
      },
      client,
    );
    if (!document) throw new Error("Unable to create the source document registry row.");

    const version = await insertVersion({
      scope,
      documentId,
      versionId,
      versionNumber: 1,
      input: versionInput,
      now,
      client,
    });
    const linkedDocument = await setCurrentVersion(scope, documentId, version.id, now, client);
    return {
      document: mapDocument(linkedDocument),
      version,
      duplicateContentMatches,
    };
  });
}

/**
 * Appends a replacement version and advances the registry pointer atomically.
 * A row lock serializes version-number allocation, so concurrent replacements
 * cannot create two version 2 rows or leave an ambiguous current version.
 */
export async function createVersionForDocument(
  input: CreateVersionForDocumentInput,
): Promise<CreateVersionForDocumentResult> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const documentId = requiredText(input.documentId, "Document id");
  const versionInput = normalizeVersionInput(input.version);

  const createVersion = async (client: PoolClient) => {
    const document = await requireDocument(scope, documentId, client, true);
    if (document.lifecycle_status === "archived") {
      throw new ProjectSourceDocumentLifecycleError("Restore the archived document before adding a new version.");
    }

    const duplicateContentMatches = await findContentMatches(scope, versionInput.contentHash, client);
    const versionNumber = await nextVersionNumber(documentId, client);
    const now = nowIso();
    const version = await insertVersion({
      scope,
      documentId,
      versionId: createId("psdocv"),
      versionNumber,
      input: versionInput,
      now,
      client,
    });
    const linkedDocument = await setCurrentVersion(scope, documentId, version.id, now, client);
    return {
      document: mapDocument(linkedDocument),
      version,
      duplicateContentMatches,
    };
  };

  return input.client ? createVersion(input.client) : withTransaction(createVersion);
}

export async function getProjectSourceDocument(input: {
  scope: ProjectScope;
  documentId: string;
  /** Optional transactional read for lifecycle and metadata compositions. */
  client?: PoolClient;
  /** Only valid when `client` belongs to an active transaction. */
  forUpdate?: boolean;
}): Promise<ProjectSourceDocument | undefined> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const row = await findDocument(
    scope,
    requiredText(input.documentId, "Document id"),
    input.client,
    Boolean(input.forUpdate),
  );
  return row ? mapDocument(row) : undefined;
}

export async function getProjectSourceDocumentWithVersions(input: {
  scope: ProjectScope;
  documentId: string;
}): Promise<{ document: ProjectSourceDocument; versions: ProjectSourceDocumentVersion[] } | undefined> {
  const document = await getProjectSourceDocument(input);
  if (!document) return undefined;
  const versions = await listProjectSourceDocumentVersions({
    scope: input.scope,
    documentId: document.id,
    limit: 250,
  });
  return { document, versions };
}

export async function listProjectSourceDocuments(input: {
  scope: ProjectScope;
  lifecycleStatus?: ProjectSourceDocumentLifecycleStatus;
  documentKind?: ProjectSourceDocumentKind;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<ProjectSourceDocument[]> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const params: Record<string, unknown> = {
    ...scopeParams(scope),
    limit: normalizeLimit(input.limit),
    offset: normalizeOffset(input.offset),
  };
  const conditions = [
    "workspace_id = @workspaceId",
    "project_id = @projectId",
    "azure_project_id = @azureProjectId",
  ];

  if (input.lifecycleStatus !== undefined) {
    params.lifecycleStatus = normalizeLifecycleStatus(input.lifecycleStatus);
    conditions.push("lifecycle_status = @lifecycleStatus");
  }
  if (input.documentKind !== undefined) {
    params.documentKind = normalizeDocumentKind(input.documentKind);
    conditions.push("document_kind = @documentKind");
  }
  const search = normalizeSearch(input.search);
  if (search) {
    params.search = `%${search}%`;
    conditions.push("(document_name ILIKE @search OR COALESCE(description, '') ILIKE @search)");
  }

  const rows = await sqlAll<ProjectSourceDocumentRow>(
    `
      SELECT ${DOCUMENT_SELECT_COLUMNS}
      FROM project_source_documents
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC, id DESC
      LIMIT @limit OFFSET @offset
    `,
    params,
  );
  return rows.map(mapDocument);
}

export async function updateProjectSourceDocumentMetadata(
  input: UpdateProjectSourceDocumentMetadataInput,
): Promise<ProjectSourceDocument> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const documentId = requiredText(input.documentId, "Document id");

  const update = async (client: PoolClient) => {
    const existing = await requireDocument(scope, documentId, client, true);
    const documentName = hasOwn(input, "documentName")
      ? requiredText(input.documentName, "Document name")
      : existing.document_name;
    const description = hasOwn(input, "description")
      ? optionalText(input.description, "Description")
      : existing.description;
    const tags = hasOwn(input, "tags") ? normalizeTags(input.tags) : jsonStringArray(existing.tags_json);
    const languageHint = hasOwn(input, "languageHint")
      ? optionalText(input.languageHint, "Language hint")
      : existing.language_hint;
    const now = nowIso();

    const row = await sqlGet<ProjectSourceDocumentRow>(
      `
        UPDATE project_source_documents
        SET document_name = @documentName,
            description = @description,
            tags_json = @tagsJson,
            language_hint = @languageHint,
            updated_at = @now
        WHERE id = @documentId
          AND workspace_id = @workspaceId
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
        RETURNING ${DOCUMENT_SELECT_COLUMNS}
      `,
      {
        ...scopeParams(scope),
        documentId,
        documentName,
        description,
        tagsJson: JSON.stringify(tags),
        languageHint,
        now,
      },
      client,
    );
    if (!row) throw new ProjectSourceDocumentNotFoundError("document");

    // A document title is deliberately user-editable while parsed text is not.
    // Chunks retain the title that retrieval/citation rendering reads, so carry
    // a title change to every immutable-version chunk for this logical source.
    // The caller refreshes the derived FTS mirror in the same transaction.
    if (existing.document_name !== documentName) {
      await sqlRun(
        `
          UPDATE document_chunks
          SET document_name = @documentName,
              updated_at = @now
          WHERE workspace_id = @workspaceId
            AND project_id = @projectId
            AND azure_project_id = @azureProjectId
            AND document_id = @documentId
            AND source_type = 'uploaded_document'
        `,
        {
          ...scopeParams(scope),
          documentId,
          documentName,
          now,
        },
        client,
      );
    }
    return mapDocument(row);
  };

  return input.client ? update(input.client) : withTransaction(update);
}

export async function updateVersionParseState(input: UpdateVersionParseStateInput): Promise<ProjectSourceDocumentVersion> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const versionId = requiredText(input.versionId, "Version id");
  const parseStatus = normalizeParseStatus(input.parseStatus);

  return withTransaction(async (client) => {
    const existing = await requireVersion(scope, versionId, client, true);
    const parseError = hasOwn(input, "parseError")
      ? optionalText(input.parseError, "Parse error")
      : existing.parse_error;
    const parseWarnings = hasOwn(input, "parseWarnings")
      ? normalizeWarnings(input.parseWarnings)
      : jsonStringArray(existing.parse_warnings_json);
    const parseRecipeVersion = hasOwn(input, "parseRecipeVersion")
      ? optionalText(input.parseRecipeVersion, "Parse recipe version")
      : existing.parse_recipe_version;
    const chunkCount = hasOwn(input, "chunkCount")
      ? normalizeNonNegativeInteger(input.chunkCount, "Chunk count")
      : existing.chunk_count;
    const metadata = hasOwn(input, "metadata")
      ? normalizeMetadata(input.metadata)
      : jsonRecord(existing.metadata_json);
    const now = nowIso();

    const row = await sqlGet<ProjectSourceDocumentVersionRow>(
      `
        UPDATE project_source_document_versions
        SET parse_status = @parseStatus,
            parse_error = @parseError,
            parse_warnings_json = @parseWarningsJson,
            parse_recipe_version = @parseRecipeVersion,
            chunk_count = @chunkCount,
            metadata_json = @metadataJson,
            updated_at = @now
        WHERE id = @versionId
          AND workspace_id = @workspaceId
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
        RETURNING ${VERSION_SELECT_COLUMNS}
      `,
      {
        ...scopeParams(scope),
        versionId,
        parseStatus,
        parseError,
        parseWarningsJson: JSON.stringify(parseWarnings),
        parseRecipeVersion,
        chunkCount,
        metadataJson: JSON.stringify(metadata),
        now,
      },
      client,
    );
    if (!row) throw new ProjectSourceDocumentNotFoundError("version");
    return mapVersion(row);
  });
}

export async function archiveProjectSourceDocument(input: {
  scope: ProjectScope;
  documentId: string;
  archivedBy: string;
  reason?: string | null;
  /**
   * Lets a lifecycle caller compose the registry transition with derived state
   * (FTS and knowledge freshness) in the same transaction.  Omitted by normal
   * callers, which retain the service's standalone transaction behavior.
   */
  client?: PoolClient;
}): Promise<ProjectSourceDocument> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const documentId = requiredText(input.documentId, "Document id");
  const archivedBy = requiredText(input.archivedBy, "Archived by");
  const archivedReason = optionalText(input.reason, "Archive reason");

  const archive = async (client: PoolClient) => {
    const existing = await requireDocument(scope, documentId, client, true);
    if (existing.lifecycle_status === "archived") return mapDocument(existing);
    const now = nowIso();
    const row = await sqlGet<ProjectSourceDocumentRow>(
      `
        UPDATE project_source_documents
        SET lifecycle_status = 'archived',
            archived_at = @now,
            archived_by = @archivedBy,
            archived_reason = @archivedReason,
            updated_at = @now
        WHERE id = @documentId
          AND workspace_id = @workspaceId
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
        RETURNING ${DOCUMENT_SELECT_COLUMNS}
      `,
      {
        ...scopeParams(scope),
        documentId,
        archivedBy,
        archivedReason,
        now,
      },
      client,
    );
    if (!row) throw new ProjectSourceDocumentNotFoundError("document");
    return mapDocument(row);
  };

  return input.client ? archive(input.client) : withTransaction(archive);
}

export async function restoreProjectSourceDocument(input: {
  scope: ProjectScope;
  documentId: string;
  /** See archiveProjectSourceDocument for transactional composition semantics. */
  client?: PoolClient;
}): Promise<ProjectSourceDocument> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const documentId = requiredText(input.documentId, "Document id");

  const restore = async (client: PoolClient) => {
    const existing = await requireDocument(scope, documentId, client, true);
    if (existing.lifecycle_status === "active") return mapDocument(existing);
    const now = nowIso();
    const row = await sqlGet<ProjectSourceDocumentRow>(
      `
        UPDATE project_source_documents
        SET lifecycle_status = 'active',
            archived_at = NULL,
            archived_by = NULL,
            archived_reason = NULL,
            updated_at = @now
        WHERE id = @documentId
          AND workspace_id = @workspaceId
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
        RETURNING ${DOCUMENT_SELECT_COLUMNS}
      `,
      { ...scopeParams(scope), documentId, now },
      client,
    );
    if (!row) throw new ProjectSourceDocumentNotFoundError("document");
    return mapDocument(row);
  };

  return input.client ? restore(input.client) : withTransaction(restore);
}

export async function getProjectSourceDocumentVersion(input: {
  scope: ProjectScope;
  versionId: string;
}): Promise<ProjectSourceDocumentVersion | undefined> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const row = await findVersion(scope, requiredText(input.versionId, "Version id"));
  return row ? mapVersion(row) : undefined;
}

/** Alias for callers that prefer explicit "find" semantics for an optional row. */
export const findProjectSourceDocumentVersion = getProjectSourceDocumentVersion;

export async function listProjectSourceDocumentVersions(input: {
  scope: ProjectScope;
  documentId: string;
  limit?: number;
  offset?: number;
}): Promise<ProjectSourceDocumentVersion[]> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const documentId = requiredText(input.documentId, "Document id");
  const rows = await sqlAll<ProjectSourceDocumentVersionRow>(
    `
      SELECT ${VERSION_SELECT_COLUMNS}
      FROM project_source_document_versions
      WHERE workspace_id = @workspaceId
        AND project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND document_id = @documentId
      ORDER BY version_number DESC
      LIMIT @limit OFFSET @offset
    `,
    {
      ...scopeParams(scope),
      documentId,
      limit: normalizeLimit(input.limit),
      offset: normalizeOffset(input.offset),
    },
  );
  return rows.map(mapVersion);
}

/**
 * Duplicate detection is deliberately advisory.  Re-uploading a previously
 * archived document, or attaching the same bytes to a differently named logical
 * source, remains a caller decision rather than a database uniqueness failure.
 */
export async function findProjectSourceDocumentContentMatches(input: {
  scope: ProjectScope;
  contentHash: string;
  includeArchived?: boolean;
}): Promise<ProjectSourceDocumentContentMatch[]> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const contentHash = normalizeContentHash(input.contentHash);
  return findContentMatches(scope, contentHash, undefined, input.includeArchived ?? true);
}

/**
 * Reads only document-source chunks.  Ingestion owns writes; M0 exposes this
 * scoped read to keep future preview/download routes out of direct SQL.
 */
export async function listProjectSourceDocumentChunks(input: {
  scope: ProjectScope;
  documentId: string;
  sourceDocumentVersionId?: string;
  limit?: number;
  offset?: number;
}): Promise<ProjectSourceDocumentChunk[]> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const documentId = requiredText(input.documentId, "Document id");
  const params: Record<string, unknown> = {
    ...scopeParams(scope),
    documentId,
    limit: normalizeLimit(input.limit),
    offset: normalizeOffset(input.offset),
  };
  const sourceDocumentVersionId = input.sourceDocumentVersionId === undefined
    ? undefined
    : requiredText(input.sourceDocumentVersionId, "Source document version id");
  const versionFilter = sourceDocumentVersionId
    ? "AND source_document_version_id = @sourceDocumentVersionId"
    : "";
  if (sourceDocumentVersionId) {
    params.sourceDocumentVersionId = sourceDocumentVersionId;
  }

  const rows = await sqlAll<{
    id: string;
    document_id: string;
    source_document_version_id: string | null;
    document_name: string | null;
    document_type: string | null;
    section: string | null;
    page_number: number | null;
    chunk_index: number;
    content: string;
    metadata_json: unknown;
    created_at: string;
    updated_at: string;
  }>(
    `
      SELECT id, document_id, source_document_version_id, document_name,
             document_type, section, page_number, chunk_index, content,
             metadata_json, created_at, updated_at
      FROM document_chunks
      WHERE workspace_id = @workspaceId
        AND project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND source_type = 'uploaded_document'
        AND document_id = @documentId
        ${versionFilter}
      ORDER BY source_document_version_id, section, chunk_index, id
      LIMIT @limit OFFSET @offset
    `,
    params,
  );
  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    sourceDocumentVersionId: row.source_document_version_id,
    documentName: row.document_name,
    documentType: row.document_type,
    section: row.section,
    pageNumber: row.page_number,
    chunkIndex: row.chunk_index,
    content: row.content,
    metadata: jsonRecord(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Short integration-oriented alias. */
export const listDocumentChunks = listProjectSourceDocumentChunks;

export type ProjectSourceDocumentDisplayInfo = {
  documentNames: Map<string, string>;
  versionNumbers: Map<string, number>;
};

/**
 * Batch, read-time lookup of document/version display metadata.  Provenance
 * records (see project-knowledge.schema.ts evidence refs) deliberately store
 * only `sourceDocumentId`/`sourceDocumentVersionId` — never names, since a
 * rename must not go stale in already-hashed provenance.  Callers resolve the
 * current name at read time via this lookup instead.
 */
export async function getProjectSourceDocumentDisplayInfo(input: {
  scope: ProjectScope;
  documentIds: string[];
  versionIds?: string[];
}): Promise<ProjectSourceDocumentDisplayInfo> {
  const scope = requireWorkspaceProjectScope(input.scope);
  const documentIds = Array.from(new Set(input.documentIds.filter(Boolean)));
  const versionIds = Array.from(new Set((input.versionIds ?? []).filter(Boolean)));

  const [documentRows, versionRows] = await Promise.all([
    documentIds.length
      ? sqlAll<{ id: string; document_name: string }>(
          `
            SELECT id, document_name
            FROM project_source_documents
            WHERE workspace_id = @workspaceId
              AND project_id = @projectId
              AND azure_project_id = @azureProjectId
              AND id = ANY(@documentIds::text[])
          `,
          { ...scopeParams(scope), documentIds },
        )
      : Promise.resolve([]),
    versionIds.length
      ? sqlAll<{ id: string; version_number: number }>(
          `
            SELECT id, version_number
            FROM project_source_document_versions
            WHERE workspace_id = @workspaceId
              AND project_id = @projectId
              AND azure_project_id = @azureProjectId
              AND id = ANY(@versionIds::text[])
          `,
          { ...scopeParams(scope), versionIds },
        )
      : Promise.resolve([]),
  ]);

  return {
    documentNames: new Map(documentRows.map((row) => [row.id, row.document_name])),
    versionNumbers: new Map(versionRows.map((row) => [row.id, row.version_number])),
  };
}

function requireWorkspaceProjectScope(input: ProjectScope): WorkspaceProjectScope {
  const scope = assertProjectScope(input);
  const workspaceId = requiredText(scope.workspaceId, "Workspace id");
  return { ...scope, workspaceId };
}

function scopeParams(scope: WorkspaceProjectScope) {
  return {
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
  };
}

function normalizeDocumentCreateInput(input: CreateDocumentWithVersionInput) {
  return {
    documentName: requiredText(input.documentName, "Document name"),
    description: optionalText(input.description, "Description"),
    tags: normalizeTags(input.tags),
    languageHint: optionalText(input.languageHint, "Language hint"),
    documentKind: normalizeDocumentKind(input.documentKind ?? "document"),
    sourceConnector: normalizeSourceConnector(input.sourceConnector ?? "upload"),
    externalReference: optionalText(input.externalReference, "External reference"),
    createdBy: requiredText(input.createdBy, "Created by"),
  };
}

function normalizeVersionInput(
  input: CreateProjectSourceDocumentVersionInput,
  fallbackUploadedBy?: string,
) {
  return {
    storageBackend: normalizeStorageBackend(input.storageBackend ?? "local_fs"),
    storageKey: requiredText(input.storageKey, "Storage key"),
    originalFileName: requiredText(input.originalFileName, "Original file name"),
    mimeType: requiredText(input.mimeType, "MIME type").toLowerCase(),
    fileFormat: normalizeFileFormat(input.fileFormat),
    byteSize: normalizeNonNegativeInteger(input.byteSize, "Byte size"),
    contentHash: normalizeContentHash(input.contentHash),
    uploadedBy: requiredText(input.uploadedBy ?? fallbackUploadedBy, "Uploaded by"),
    parseStatus: normalizeParseStatus(input.parseStatus ?? "pending"),
    parseError: optionalText(input.parseError, "Parse error"),
    parseWarnings: normalizeWarnings(input.parseWarnings),
    parseRecipeVersion: optionalText(input.parseRecipeVersion, "Parse recipe version"),
    chunkCount: normalizeNonNegativeInteger(input.chunkCount ?? 0, "Chunk count"),
    metadata: normalizeMetadata(input.metadata),
  };
}

async function insertVersion(input: {
  scope: WorkspaceProjectScope;
  documentId: string;
  versionId: string;
  versionNumber: number;
  input: ReturnType<typeof normalizeVersionInput>;
  now: string;
  client: PoolClient;
}): Promise<ProjectSourceDocumentVersion> {
  const row = await sqlGet<ProjectSourceDocumentVersionRow>(
    `
      INSERT INTO project_source_document_versions (
        id, document_id, workspace_id, project_id, azure_project_id,
        version_number, storage_backend, storage_key, original_file_name,
        mime_type, file_format, byte_size, content_hash, parse_status,
        parse_error, parse_warnings_json, parse_recipe_version, chunk_count,
        metadata_json, uploaded_by, created_at, updated_at
      ) VALUES (
        @id, @documentId, @workspaceId, @projectId, @azureProjectId,
        @versionNumber, @storageBackend, @storageKey, @originalFileName,
        @mimeType, @fileFormat, @byteSize, @contentHash, @parseStatus,
        @parseError, @parseWarningsJson, @parseRecipeVersion, @chunkCount,
        @metadataJson, @uploadedBy, @now, @now
      )
      RETURNING ${VERSION_SELECT_COLUMNS}
    `,
    {
      id: input.versionId,
      documentId: input.documentId,
      ...scopeParams(input.scope),
      versionNumber: input.versionNumber,
      ...input.input,
      parseWarningsJson: JSON.stringify(input.input.parseWarnings),
      metadataJson: JSON.stringify(input.input.metadata),
      now: input.now,
    },
    input.client,
  );
  if (!row) throw new Error("Unable to create the source document version row.");
  return mapVersion(row);
}

async function setCurrentVersion(
  scope: WorkspaceProjectScope,
  documentId: string,
  versionId: string,
  now: string,
  client: PoolClient,
): Promise<ProjectSourceDocumentRow> {
  const row = await sqlGet<ProjectSourceDocumentRow>(
    `
      UPDATE project_source_documents
      SET current_version_id = @versionId,
          updated_at = @now
      WHERE id = @documentId
        AND workspace_id = @workspaceId
        AND project_id = @projectId
        AND azure_project_id = @azureProjectId
      RETURNING ${DOCUMENT_SELECT_COLUMNS}
    `,
    { ...scopeParams(scope), documentId, versionId, now },
    client,
  );
  if (!row) throw new ProjectSourceDocumentNotFoundError("document");
  return row;
}

async function nextVersionNumber(documentId: string, client: PoolClient): Promise<number> {
  const row = await sqlGet<{ next_version_number: number | string }>(
    `
      SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version_number
      FROM project_source_document_versions
      WHERE document_id = @documentId
    `,
    { documentId },
    client,
  );
  const value = Number(row?.next_version_number ?? 1);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Unable to allocate a source document version number.");
  }
  return value;
}

async function findDocument(
  scope: WorkspaceProjectScope,
  documentId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<ProjectSourceDocumentRow | undefined> {
  return sqlGet<ProjectSourceDocumentRow>(
    `
      SELECT ${DOCUMENT_SELECT_COLUMNS}
      FROM project_source_documents
      WHERE id = @documentId
        AND workspace_id = @workspaceId
        AND project_id = @projectId
        AND azure_project_id = @azureProjectId
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    { ...scopeParams(scope), documentId },
    client,
  );
}

async function requireDocument(
  scope: WorkspaceProjectScope,
  documentId: string,
  client: PoolClient,
  forUpdate = false,
): Promise<ProjectSourceDocumentRow> {
  const row = await findDocument(scope, documentId, client, forUpdate);
  if (!row) throw new ProjectSourceDocumentNotFoundError("document");
  return row;
}

async function findVersion(
  scope: WorkspaceProjectScope,
  versionId: string,
  client?: PoolClient,
  forUpdate = false,
): Promise<ProjectSourceDocumentVersionRow | undefined> {
  return sqlGet<ProjectSourceDocumentVersionRow>(
    `
      SELECT ${VERSION_SELECT_COLUMNS}
      FROM project_source_document_versions
      WHERE id = @versionId
        AND workspace_id = @workspaceId
        AND project_id = @projectId
        AND azure_project_id = @azureProjectId
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    { ...scopeParams(scope), versionId },
    client,
  );
}

async function requireVersion(
  scope: WorkspaceProjectScope,
  versionId: string,
  client: PoolClient,
  forUpdate = false,
): Promise<ProjectSourceDocumentVersionRow> {
  const row = await findVersion(scope, versionId, client, forUpdate);
  if (!row) throw new ProjectSourceDocumentNotFoundError("version");
  return row;
}

async function findContentMatches(
  scope: WorkspaceProjectScope,
  contentHash: string,
  client?: PoolClient,
  includeArchived = true,
): Promise<ProjectSourceDocumentContentMatch[]> {
  const rows = await sqlAll<ProjectSourceDocumentContentMatchRow>(
    `
      SELECT d.id AS document_id,
             d.document_name,
             d.lifecycle_status,
             d.current_version_id,
             v.id AS version_id,
             v.version_number,
             v.content_hash,
             v.created_at AS version_created_at
      FROM project_source_document_versions v
      JOIN project_source_documents d ON d.id = v.document_id
      WHERE v.workspace_id = @workspaceId
        AND v.project_id = @projectId
        AND v.azure_project_id = @azureProjectId
        AND v.content_hash = @contentHash
        AND (@includeArchived OR d.lifecycle_status = 'active')
      ORDER BY v.created_at DESC, v.id DESC
    `,
    { ...scopeParams(scope), contentHash, includeArchived },
    client,
  );
  return rows.map((row) => ({
    document: {
      id: row.document_id,
      documentName: row.document_name,
      lifecycleStatus: row.lifecycle_status,
      currentVersionId: row.current_version_id,
    },
    version: {
      id: row.version_id,
      versionNumber: row.version_number,
      contentHash: row.content_hash,
      createdAt: row.version_created_at,
    },
  }));
}

function mapDocument(row: ProjectSourceDocumentRow): ProjectSourceDocument {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    azureProjectId: row.azure_project_id,
    azureProjectName: row.azure_project_name,
    azureOrganizationUrl: row.azure_organization_url,
    documentName: row.document_name,
    description: row.description,
    tags: jsonStringArray(row.tags_json),
    languageHint: row.language_hint,
    documentKind: row.document_kind,
    sourceConnector: row.source_connector,
    externalReference: row.external_reference,
    currentVersionId: row.current_version_id,
    lifecycleStatus: row.lifecycle_status,
    archivedAt: row.archived_at,
    archivedBy: row.archived_by,
    archivedReason: row.archived_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: ProjectSourceDocumentVersionRow): ProjectSourceDocumentVersion {
  const byteSize = Number(row.byte_size);
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new ProjectSourceDocumentValidationError("Stored source document version has an invalid byte size.");
  }
  return {
    id: row.id,
    documentId: row.document_id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    azureProjectId: row.azure_project_id,
    versionNumber: row.version_number,
    storageBackend: row.storage_backend,
    storageKey: row.storage_key,
    originalFileName: row.original_file_name,
    mimeType: row.mime_type,
    fileFormat: row.file_format,
    byteSize,
    contentHash: row.content_hash,
    parseStatus: row.parse_status,
    parseError: row.parse_error,
    parseWarnings: jsonStringArray(row.parse_warnings_json),
    parseRecipeVersion: row.parse_recipe_version,
    chunkCount: row.chunk_count,
    metadata: jsonRecord(row.metadata_json),
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProjectSourceDocumentValidationError(`${label} is required.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ProjectSourceDocumentValidationError(`${label} must be text.`);
  }
  return value.trim() || null;
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new ProjectSourceDocumentValidationError("Tags must be an array of text values.");
  }
  return [...new Set(value.map((tag) => tag.trim()).filter(Boolean))];
}

function normalizeWarnings(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((warning) => typeof warning !== "string")) {
    throw new ProjectSourceDocumentValidationError("Parse warnings must be an array of text values.");
  }
  return value.map((warning) => warning.trim()).filter(Boolean);
}

function normalizeMetadata(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectSourceDocumentValidationError("Document metadata must be a JSON object.");
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    throw new ProjectSourceDocumentValidationError("Document metadata must be JSON-serializable.");
  }
}

function normalizeDocumentKind(value: unknown): ProjectSourceDocumentKind {
  if (typeof value === "string" && PROJECT_SOURCE_DOCUMENT_KINDS.includes(value as ProjectSourceDocumentKind)) {
    return value as ProjectSourceDocumentKind;
  }
  throw new ProjectSourceDocumentValidationError("Document kind is invalid.");
}

function normalizeSourceConnector(value: unknown): ProjectSourceDocumentConnector {
  if (
    typeof value === "string" &&
    PROJECT_SOURCE_DOCUMENT_CONNECTORS.includes(value as ProjectSourceDocumentConnector)
  ) {
    return value as ProjectSourceDocumentConnector;
  }
  throw new ProjectSourceDocumentValidationError("Document source connector is invalid.");
}

function normalizeStorageBackend(value: unknown): DocumentStorageBackendKind {
  if (typeof value === "string" && DOCUMENT_STORAGE_BACKENDS.includes(value as DocumentStorageBackendKind)) {
    return value as DocumentStorageBackendKind;
  }
  throw new ProjectSourceDocumentValidationError("Document storage backend is invalid.");
}

function normalizeFileFormat(value: unknown): ProjectSourceDocumentFileFormat {
  if (
    typeof value === "string" &&
    PROJECT_SOURCE_DOCUMENT_FILE_FORMATS.includes(value as ProjectSourceDocumentFileFormat)
  ) {
    return value as ProjectSourceDocumentFileFormat;
  }
  throw new ProjectSourceDocumentValidationError("Document file format is invalid.");
}

function normalizeParseStatus(value: unknown): ProjectSourceDocumentParseStatus {
  if (
    typeof value === "string" &&
    PROJECT_SOURCE_DOCUMENT_PARSE_STATUSES.includes(value as ProjectSourceDocumentParseStatus)
  ) {
    return value as ProjectSourceDocumentParseStatus;
  }
  throw new ProjectSourceDocumentValidationError("Document parse status is invalid.");
}

function normalizeLifecycleStatus(value: unknown): ProjectSourceDocumentLifecycleStatus {
  if (
    typeof value === "string" &&
    PROJECT_SOURCE_DOCUMENT_LIFECYCLE_STATUSES.includes(value as ProjectSourceDocumentLifecycleStatus)
  ) {
    return value as ProjectSourceDocumentLifecycleStatus;
  }
  throw new ProjectSourceDocumentValidationError("Document lifecycle status is invalid.");
}

function normalizeContentHash(value: unknown): string {
  const contentHash = requiredText(value, "Content hash").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new ProjectSourceDocumentValidationError("Content hash must be a SHA-256 hexadecimal digest.");
  }
  return contentHash;
}

function normalizeNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProjectSourceDocumentValidationError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) return 50;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ProjectSourceDocumentValidationError("Limit must be a positive integer.");
  }
  return Math.min(value, 250);
}

function normalizeOffset(value: unknown): number {
  if (value === undefined) return 0;
  return normalizeNonNegativeInteger(value, "Offset");
}

function normalizeSearch(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ProjectSourceDocumentValidationError("Search must be text.");
  const normalized = value.trim();
  return normalized || undefined;
}

function jsonStringArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
}

function jsonRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function hasOwn(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}
