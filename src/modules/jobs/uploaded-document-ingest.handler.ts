import "server-only";

import { z } from "zod";

import { parseDocument, DOCUMENT_PARSE_RECIPE_VERSION } from "@/modules/documents/document-parser-registry";
import { getDocumentStorageBackend } from "@/modules/documents/document-storage.service";
import {
  getProjectSourceDocument,
  getProjectSourceDocumentVersion,
  updateVersionParseState,
} from "@/modules/documents/project-source-documents.service";
import { getDocumentMaxUploadBytes } from "@/modules/documents/document-upload-validation";
import { isDocumentParseError } from "@/modules/documents/parsed-document.types";
import { writeAuditLog } from "@/modules/audit/audit.service";
import { chunkText } from "@/modules/rag/rag-pipeline.service";
import { refreshProjectContextSearchIndex } from "@/modules/rag/context-chatbot-retrieval.service";
import { createEmbeddingProvider } from "@/modules/rag/embedding-provider";
import { syncProjectDocumentEmbeddings } from "@/modules/rag/embedding-store.service";
import { acquireProjectKnowledgeLock } from "@/modules/rag/project-knowledge-lock";
import { markProjectKnowledgeSourceDrift } from "@/modules/rag/project-knowledge-draft.service";
import { withEmbeddingSyncLock } from "@/modules/rag/project-context-store.service";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { nowIso, sqlGet, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import type { JobHandler } from "./job-handlers";

const PayloadSchema = z.object({
  projectId: z.string().min(1),
  versionId: z.string().min(1),
});

/** Caps persistence even if a parser adds unexpectedly granular sections. */
export const MAX_UPLOADED_DOCUMENT_CHUNKS = 2_000;

const DELETE_VERSION_CHUNKS_SQL = `
  DELETE FROM document_chunks
  WHERE workspace_id = @workspaceId
    AND project_id = @projectId
    AND azure_project_id = @azureProjectId
    AND source_type = 'uploaded_document'
    AND document_id = @documentId
    AND source_document_version_id = @versionId
`;

const DELETE_VERSION_EMBEDDINGS_SQL = `
  DELETE FROM embeddings
  WHERE workspace_id = @workspaceId
    AND project_id = @projectId
    AND azure_project_id = @azureProjectId
    AND source_type = 'uploaded_document_chunk'
    AND chunk_id IN (
      SELECT id FROM document_chunks
      WHERE workspace_id = @workspaceId
        AND project_id = @projectId
        AND azure_project_id = @azureProjectId
        AND source_type = 'uploaded_document'
        AND document_id = @documentId
        AND source_document_version_id = @versionId
    )
`;

const INSERT_DOCUMENT_CHUNK_SQL = `
  INSERT INTO document_chunks (
    id, workspace_id, project_id, azure_project_id, azure_project_name, source_type,
    azure_work_item_id, work_item_type, document_id, source_document_version_id,
    document_name, document_type, section, page_number, chunk_index, content,
    metadata_json, source_snapshot_id, created_at, updated_at
  ) VALUES (
    @id, @workspaceId, @projectId, @azureProjectId, @azureProjectName, 'uploaded_document',
    NULL, NULL, @documentId, @sourceDocumentVersionId,
    @documentName, @documentType, @section, @pageNumber, @chunkIndex, @content,
    @metadataJson, NULL, @createdAt, @updatedAt
  )
`;

/**
 * Parses a stored immutable source version, replaces only that version's derived
 * chunks, refreshes lexical retrieval, then best-effort embeds the result. A
 * parse failure is recorded as a terminal version state rather than retried
 * forever; infrastructure failures still escape so the queue can retry them.
 */
export const runUploadedDocumentIngestJob: JobHandler = async (job, context) => {
  if (!job.workspaceId) throw new Error("An uploaded-document job requires a workspace.");
  const payload = PayloadSchema.parse(job.payload);
  const scope = await loadProjectScope(job.workspaceId, payload.projectId);
  context.signal.throwIfAborted();

  const version = await getProjectSourceDocumentVersion({ scope, versionId: payload.versionId });
  if (!version) throw new Error("The uploaded document version was not found in this workspace project.");
  const document = await getProjectSourceDocument({ scope, documentId: version.documentId });
  if (!document) throw new Error("The uploaded document was not found in this workspace project.");

  // An archived document intentionally has no active retrieval presence. Its
  // queued ingest can complete harmlessly as a no-op instead of reviving it.
  if (document.lifecycleStatus === "archived") {
    return { outcome: "skipped_archived", documentId: document.id, versionId: version.id, chunkCount: 0 };
  }

  await updateVersionParseState({
    scope,
    versionId: version.id,
    parseStatus: "parsing",
    parseError: null,
    parseWarnings: [],
    parseRecipeVersion: DOCUMENT_PARSE_RECIPE_VERSION,
    chunkCount: 0,
  });
  await context.updateProgress({ phase: "reading_document", percent: 8, versionId: version.id });

  try {
    const sourceBytes = await readStoredDocument(version.storageKey, version.byteSize, context.signal);
    await context.updateProgress({ phase: "parsing_document", percent: 24, versionId: version.id });
    const parsed = await parseDocument({
      format: version.fileFormat,
      data: sourceBytes,
      fileName: version.originalFileName,
      languageHint: document.languageHint,
      signal: context.signal,
    });
    context.signal.throwIfAborted();

    const chunkBuild = buildDocumentChunks({ scope, documentName: document.documentName, versionId: version.id, parsed });
    const warnings = [
      ...parsed.warnings.map((warning) => warning.message),
      ...(chunkBuild.truncated ? [`Only the first ${MAX_UPLOADED_DOCUMENT_CHUNKS.toLocaleString()} chunks were indexed.`] : []),
    ];
    const parseStatus = parsed.status === "empty"
      ? "parsed"
      : parsed.status === "partially_parsed" || chunkBuild.truncated
        ? "partially_parsed"
        : "parsed";

    await context.updateProgress({
      phase: "indexing_chunks",
      percent: 55,
      completed: chunkBuild.chunks.length,
      total: chunkBuild.chunks.length,
      versionId: version.id,
    });
    await replaceDocumentVersionChunks({
      scope,
      documentId: document.id,
      versionId: version.id,
      documentName: document.documentName,
      documentType: version.fileFormat,
      chunks: chunkBuild.chunks,
      signal: context.signal,
    });
    context.signal.throwIfAborted();

    await updateVersionParseState({
      scope,
      versionId: version.id,
      parseStatus,
      parseError: null,
      parseWarnings: warnings,
      parseRecipeVersion: DOCUMENT_PARSE_RECIPE_VERSION,
      chunkCount: chunkBuild.chunks.length,
      metadata: {
        ...version.metadata,
        ...parsed.documentMetadata,
        indexedChunkCount: chunkBuild.chunks.length,
        indexedAt: nowIso(),
      },
    });

    await context.updateProgress({ phase: "embedding_chunks", percent: 78, versionId: version.id });
    const embedding = await embedDocumentChunks(scope).catch((error) => {
      console.error("Document embedding sync failed; lexical retrieval remains available.", error);
      return undefined;
    });
    await context.updateProgress({ phase: "complete", percent: 100, versionId: version.id, warningCount: warnings.length });
    writeAuditLog({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_source_document_version",
      entityId: version.id,
      action: "documents.ingested",
      status: parseStatus === "partially_parsed" ? "Partial failure" : "Success",
      actor: job.createdByUserId ?? "system:worker",
      message: `Processed ${document.documentName} version ${version.versionNumber}.`,
      details: { documentId: document.id, versionId: version.id, chunkCount: chunkBuild.chunks.length, warningCount: warnings.length },
    });
    return {
      outcome: parseStatus === "partially_parsed" ? "partially_parsed" : "parsed",
      documentId: document.id,
      versionId: version.id,
      chunkCount: chunkBuild.chunks.length,
      warningCount: warnings.length,
      parseStatus,
      ...(embedding ? { embeddedChunkCount: embedding.embeddedChunkCount } : {}),
    };
  } catch (error) {
    if (context.signal.aborted) throw error;
    if (!isDocumentParseError(error)) throw error;
    await updateVersionParseState({
      scope,
      versionId: version.id,
      parseStatus: "parse_failed",
      parseError: error.message,
      parseWarnings: [],
      parseRecipeVersion: DOCUMENT_PARSE_RECIPE_VERSION,
      chunkCount: 0,
    });
    writeAuditLog({
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_source_document_version",
      entityId: version.id,
      action: "documents.ingest_failed",
      status: "Failed",
      actor: job.createdByUserId ?? "system:worker",
      message: `Could not parse ${document.documentName}: ${error.message}`,
      details: { documentId: document.id, versionId: version.id, code: error.code },
    });
    return {
      outcome: "parse_failed",
      documentId: document.id,
      versionId: version.id,
      chunkCount: 0,
      warningCount: 0,
      parseStatus: "parse_failed",
    };
  }
};

type IndexedDocumentChunk = {
  id: string;
  chunkIndex: number;
  content: string;
  section: string;
  pageNumber: number | null;
  metadata: Record<string, unknown>;
};

function buildDocumentChunks(input: {
  scope: ProjectScope;
  documentName: string;
  versionId: string;
  parsed: Awaited<ReturnType<typeof parseDocument>>;
}): { chunks: IndexedDocumentChunk[]; truncated: boolean } {
  const chunks: IndexedDocumentChunk[] = [];
  const documentOcr = input.parsed.documentMetadata.ocr;
  const ocrProvenance = documentOcr
    ? {
        origin: "ocr_text",
        engine: documentOcr.engine,
        engineVersion: documentOcr.engineVersion,
      }
    : {};
  let truncated = false;
  for (const [sectionIndex, section] of input.parsed.sections.entries()) {
    if (chunks.length >= MAX_UPLOADED_DOCUMENT_CHUNKS) {
      truncated = true;
      break;
    }
    const sectionChunks = chunkText({
      projectId: input.scope.projectId,
      azureProjectId: input.scope.azureProjectId,
      sourceId: `uploaded_document_${input.versionId}_${sectionIndex}`,
      sourceType: "uploaded_document",
      title: input.documentName,
      text: section.text,
    });
    for (const chunk of sectionChunks) {
      if (!chunk.content) continue;
      if (chunks.length >= MAX_UPLOADED_DOCUMENT_CHUNKS) {
        truncated = true;
        break;
      }
      chunks.push({
        id: chunk.id,
        chunkIndex: chunks.length,
        content: chunk.content,
        section: section.sectionKey,
        pageNumber: section.pageNumber ?? null,
        metadata: {
          ...(section.kind === "ocr_region" ? ocrProvenance : {}),
          ...section.metadata,
          sectionKind: section.kind,
          sectionKey: section.sectionKey,
          pageNumber: section.pageNumber,
          chunkIndex: chunks.length,
          sectionChunkIndex: chunk.metadata.chunkIndex,
        },
      });
    }
  }
  return { chunks, truncated };
}

async function replaceDocumentVersionChunks(input: {
  scope: ProjectScope;
  documentId: string;
  versionId: string;
  documentName: string;
  documentType: string;
  chunks: IndexedDocumentChunk[];
  signal: AbortSignal;
}) {
  const scope = input.scope;
  input.signal.throwIfAborted();
  await withTransaction(async (client) => {
    input.signal.throwIfAborted();
    await acquireProjectKnowledgeLock(scope, client);
    input.signal.throwIfAborted();
    // Remove vectors before chunks so deletion cannot lose its selection set.
    await sqlRun(DELETE_VERSION_EMBEDDINGS_SQL, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      documentId: input.documentId,
      versionId: input.versionId,
    }, client);
    await sqlRun(DELETE_VERSION_CHUNKS_SQL, {
      workspaceId: scope.workspaceId,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      documentId: input.documentId,
      versionId: input.versionId,
    }, client);
    const now = nowIso();
    for (const [index, chunk] of input.chunks.entries()) {
      // A cancellation that lands while a large document is being persisted
      // must abort the *transaction*, not merely stop the worker afterward.
      // Throwing here rolls back deletes, chunk inserts, FTS, and freshness
      // drift together, preserving the prior active corpus.
      if (index % 16 === 0) input.signal.throwIfAborted();
      await sqlRun(INSERT_DOCUMENT_CHUNK_SQL, {
        id: chunk.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
        documentId: input.documentId,
        sourceDocumentVersionId: input.versionId,
        documentName: input.documentName,
        documentType: input.documentType,
        section: chunk.section,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        metadataJson: JSON.stringify(chunk.metadata),
        createdAt: now,
        updatedAt: now,
      }, client);
    }
    input.signal.throwIfAborted();
    await refreshProjectContextSearchIndex({ scope }, client);
    input.signal.throwIfAborted();
    await markProjectKnowledgeSourceDrift(scope, {
      type: "document_ingested",
      documentId: input.documentId,
      documentVersionId: input.versionId,
      chunkCount: input.chunks.length,
    }, client);
    input.signal.throwIfAborted();
  });
}

async function embedDocumentChunks(scope: ProjectScope) {
  const provider = createEmbeddingProvider();
  const lock = await withEmbeddingSyncLock(scope.projectId, () => syncProjectDocumentEmbeddings({ scope, provider }));
  return lock.acquired ? lock.result : undefined;
}

async function readStoredDocument(storageKey: string, expectedByteSize: number, signal: AbortSignal): Promise<Uint8Array> {
  const stream = await getDocumentStorageBackend().getStream({ storageKey });
  const limit = Math.min(getDocumentMaxUploadBytes(), expectedByteSize || getDocumentMaxUploadBytes());
  const chunks: Buffer[] = [];
  let byteSize = 0;
  try {
    for await (const value of stream) {
      signal.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      byteSize += chunk.byteLength;
      if (byteSize > limit) throw new Error("Stored document exceeds the permitted upload size.");
      chunks.push(chunk);
    }
  } finally {
    if (signal.aborted) stream.destroy(signal.reason instanceof Error ? signal.reason : undefined);
  }
  if (byteSize !== expectedByteSize) throw new Error("Stored document byte size does not match its immutable version record.");
  return new Uint8Array(Buffer.concat(chunks, byteSize));
}

async function loadProjectScope(workspaceId: string, projectId: string): Promise<ProjectScope> {
  const project = await sqlGet<{
    azure_project_id: string;
    azure_project_name: string;
    azure_organization_url: string;
  }>(
    `SELECT azure_project_id, azure_project_name, azure_organization_url
     FROM projects WHERE id = @projectId AND workspace_id = @workspaceId LIMIT 1`,
    { projectId, workspaceId },
  );
  if (!project) throw new Error("The uploaded document project was not found in its workspace.");
  return {
    projectId,
    workspaceId,
    azureProjectId: project.azure_project_id,
    azureProjectName: project.azure_project_name,
    azureOrganizationUrl: project.azure_organization_url,
  };
}
