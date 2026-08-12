import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { getDocumentStorageBackend } from "@/modules/documents/document-storage.service";
import {
  createVersionForDocument,
  getProjectSourceDocument,
} from "@/modules/documents/project-source-documents.service";
import {
  canonicalDocumentMimeType,
  validateDocumentUpload,
} from "@/modules/documents/document-upload-validation";
import {
  removeStreamedDocumentMultipart,
  streamDocumentUploadMultipart,
  type StreamedDocumentMultipart,
} from "@/modules/documents/streaming-multipart-upload";
import {
  DOCUMENT_INGEST_UNAVAILABLE_CODE,
  DOCUMENT_INGEST_UNAVAILABLE_MESSAGE,
  enqueueUploadedDocumentIngestJob,
  isDocumentIngestUnavailableError,
  UPLOADED_DOCUMENT_INGEST,
} from "@/modules/jobs/uploaded-document-jobs.service";
import { hasHealthyWorkerCapability } from "@/modules/jobs/worker-registry.service";
import { refreshProjectContextSearchIndex } from "@/modules/rag/context-chatbot-retrieval.service";
import { markProjectKnowledgeDocumentSourceDrift } from "@/modules/rag/project-knowledge-draft.service";
import { withTransaction } from "@/modules/shared/infrastructure/database/db";

import {
  documentAuthOrErrorResponse,
  documentUploadRateLimitResponse,
  documentUploadSessionResponse,
  markDocumentVersionEnqueueFailed,
  parseDocumentUploadFields,
  resolveDocumentMutationScope,
  safeDocumentDownloadName,
} from "../../document-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ documentId: string }> };

/** Add exactly one immutable replacement version to a logical document. */
export async function POST(request: Request, { params }: RouteParams) {
  const limited = await documentUploadRateLimitResponse(request);
  if (limited) return limited;
  // Session gate MUST precede body consumption: streamDocumentUploadMultipart
  // writes the file to disk and hashes it, real cost an unauthenticated
  // caller must not be able to force merely by staying under the rate limit.
  // Owner/admin role enforcement still happens after the body is parsed,
  // because `scope` is a multipart field rather than a header (residual: an
  // authenticated non-owner/admin still pays the streaming cost before that
  // later check rejects them).
  const unauthenticated = await documentUploadSessionResponse();
  if (unauthenticated) return unauthenticated;

  let multipart: StreamedDocumentMultipart | undefined;
  try {
    multipart = await streamDocumentUploadMultipart(request);
    const metadata = parseDocumentUploadFields(multipart.fields);
    if (!metadata.success) return NextResponse.json({ error: metadata.error }, { status: 400 });
    if (multipart.files.length !== 1) {
      return NextResponse.json({ error: "Upload exactly one file for a replacement document version." }, { status: 400 });
    }
    if (metadata.data.title || metadata.data.description || metadata.data.tags.length || metadata.data.languageHint) {
      return NextResponse.json({ error: "Version uploads may not change source-document metadata." }, { status: 400 });
    }

    const { ctx, scope } = await resolveDocumentMutationScope(
      metadata.data.scope,
      "Only workspace owners and admins can add document versions.",
    );
    const { documentId } = await params;
    // Resolve before storage to avoid writing a blob for a non-existent or
    // cross-project logical document.
    const existing = await getProjectSourceDocument({ scope, documentId });
    if (!existing) return NextResponse.json({ error: "The requested source document was not found in the selected project." }, { status: 404 });
    if (!await hasHealthyWorkerCapability(UPLOADED_DOCUMENT_INGEST)) {
      return NextResponse.json(
        { error: DOCUMENT_INGEST_UNAVAILABLE_MESSAGE, code: DOCUMENT_INGEST_UNAVAILABLE_CODE },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }

    const file = multipart.files[0];
    const data = await readFile(file.tempPath);
    if (data.byteLength !== file.byteSize) throw new Error("The temporary upload size changed before validation.");
    const validation = await validateDocumentUpload({
      fileName: file.originalFileName,
      data,
      declaredMimeType: file.mimeType,
    });
    const storage = getDocumentStorageBackend();
    const stored = await storage.put({
      workspaceId: ctx.workspace.id,
      contentSha256: file.contentSha256,
      content: createReadStream(file.tempPath),
      expectedByteSize: file.byteSize,
    });
    // Advancing the current-version pointer immediately retires the old
    // version from retrieval. Keep that state change, FTS refresh, and
    // published-knowledge freshness in one transaction: a delayed or failed
    // parse must never leave prior claims looking current.
    const { result, impact } = await withTransaction(async (client) => {
      const result = await createVersionForDocument({
        scope,
        documentId: existing.id,
        client,
        version: {
          storageBackend: storage.kind,
          storageKey: stored.storageKey,
          originalFileName: safeDocumentDownloadName(file.originalFileName, `upload.${validation.format}`),
          mimeType: canonicalDocumentMimeType(validation.format),
          fileFormat: validation.format,
          byteSize: file.byteSize,
          contentHash: file.contentSha256,
          uploadedBy: ctx.userId,
          metadata: {
            detectedMimeType: validation.detectedMimeType ?? null,
            uploadByteLength: validation.byteLength,
          },
        },
      });
      const impact = await markProjectKnowledgeDocumentSourceDrift({
        scope,
        documentId: result.document.id,
        action: "replaced",
        client,
      });
      await refreshProjectContextSearchIndex({ scope }, client);
      return { result, impact };
    });
    // The replacement version (and its FTS/knowledge-drift transaction) is
    // already committed. An enqueue failure here must not be silently lost —
    // mark the version parse_failed (Reprocess can retry it) and still return
    // the committed version instead of masking it behind an unrelated error.
    let queued: Awaited<ReturnType<typeof enqueueUploadedDocumentIngestJob>> | undefined;
    let queueError: string | undefined;
    try {
      queued = await enqueueUploadedDocumentIngestJob({
        scope,
        workspaceId: ctx.workspace.id,
        actor: ctx.userId,
        versionId: result.version.id,
      });
    } catch (error) {
      queueError = error instanceof Error ? error.message : "The document could not be queued for processing.";
      await markDocumentVersionEnqueueFailed({ scope, versionId: result.version.id, reason: queueError });
    }
    writeAuditLog({
      workspaceId: ctx.workspace.id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_source_document_version",
      entityId: result.version.id,
      action: "documents.version_uploaded",
      status: "Success",
      actor: ctx.userId,
      message: `Uploaded version ${result.version.versionNumber} of ${result.document.documentName}.`,
      details: {
        documentId: result.document.id,
        byteSize: result.version.byteSize,
        storageCreated: stored.created,
        impactedKnowledgeEntries: impact.totalEntries,
        queueError: queueError ?? null,
      },
    });
    return NextResponse.json({
      documentId: result.document.id,
      versionId: result.version.id,
      jobId: queued?.job.id ?? null,
      document: result.document,
      version: result.version,
      job: queued?.job ?? null,
      reused: queued?.reused ?? false,
      duplicateContentMatches: result.duplicateContentMatches,
      impact,
      queueError: queueError ?? null,
    }, { status: 202 });
  } catch (error) {
    if (isDocumentIngestUnavailableError(error)) {
      return NextResponse.json(
        { error: DOCUMENT_INGEST_UNAVAILABLE_MESSAGE, code: DOCUMENT_INGEST_UNAVAILABLE_CODE },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    return documentAuthOrErrorResponse(error, "The replacement document version could not be uploaded.");
  } finally {
    if (multipart) await removeStreamedDocumentMultipart(multipart).catch(() => undefined);
  }
}
