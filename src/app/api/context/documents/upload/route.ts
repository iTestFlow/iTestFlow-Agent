import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { getDocumentStorageBackend } from "@/modules/documents/document-storage.service";
import {
  createDocumentWithVersion,
} from "@/modules/documents/project-source-documents.service";
import { validateDocumentUpload, type ValidatedDocumentUpload } from "@/modules/documents/document-upload-validation";
import {
  removeStreamedDocumentMultipart,
  streamDocumentUploadMultipart,
  type StreamedDocumentMultipart,
  type StreamedDocumentUpload,
} from "@/modules/documents/streaming-multipart-upload";
import {
  DOCUMENT_INGEST_UNAVAILABLE_CODE,
  DOCUMENT_INGEST_UNAVAILABLE_MESSAGE,
  enqueueUploadedDocumentIngestJob,
  isDocumentIngestUnavailableError,
  UPLOADED_DOCUMENT_INGEST,
} from "@/modules/jobs/uploaded-document-jobs.service";
import { hasHealthyWorkerCapability } from "@/modules/jobs/worker-registry.service";

import {
  displayDocumentNameFromFileName,
  documentAuthOrErrorResponse,
  documentUploadRateLimitResponse,
  documentUploadSessionResponse,
  markDocumentVersionEnqueueFailed,
  parseDocumentUploadFields,
  resolveDocumentMutationScope,
  safeDocumentDownloadName,
} from "../document-route-helpers";

export const runtime = "nodejs";

/**
 * Streams files into a request-private temp directory, validates their bytes,
 * then passes a generated temp path (never a client path) to the private
 * content-addressed storage backend.
 */
export async function POST(request: Request) {
  const limited = await documentUploadRateLimitResponse(request);
  if (limited) return limited;
  // Session gate MUST precede body consumption: streamDocumentUploadMultipart
  // writes every file to disk and hashes it, real cost an unauthenticated
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
    if (metadata.data.title && multipart.files.length !== 1) {
      return NextResponse.json({ error: "title may be supplied only when uploading one document." }, { status: 400 });
    }

    const { ctx, scope } = await resolveDocumentMutationScope(
      metadata.data.scope,
      "Only workspace owners and admins can upload source documents.",
    );
    if (!await hasHealthyWorkerCapability(UPLOADED_DOCUMENT_INGEST)) {
      return NextResponse.json(
        { error: DOCUMENT_INGEST_UNAVAILABLE_MESSAGE, code: DOCUMENT_INGEST_UNAVAILABLE_CODE },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }

    // Validate every file before persisting any registry rows, so an invalid
    // later file cannot leave an earlier file accepted in a nominally failed
    // multi-file request.
    const validated = await validateUploadedFiles(multipart.files);
    const storage = getDocumentStorageBackend();
    const uploads: Array<Record<string, unknown>> = [];

    for (const item of validated) {
      const stored = await storage.put({
        workspaceId: ctx.workspace.id,
        contentSha256: item.file.contentSha256,
        content: createReadStream(item.file.tempPath),
        expectedByteSize: item.file.byteSize,
      });
      const documentName = metadata.data.title ?? displayDocumentNameFromFileName(item.file.originalFileName);
      const result = await createDocumentWithVersion({
        scope,
        documentName,
        description: metadata.data.description,
        tags: metadata.data.tags,
        languageHint: metadata.data.languageHint,
        createdBy: ctx.userId,
        version: {
          storageBackend: storage.kind,
          storageKey: stored.storageKey,
          originalFileName: safeDocumentDownloadName(item.file.originalFileName, `upload.${item.validation.format}`),
          mimeType: canonicalMimeType(item.validation),
          fileFormat: item.validation.format,
          byteSize: item.file.byteSize,
          contentHash: item.file.contentSha256,
          uploadedBy: ctx.userId,
          metadata: {
            detectedMimeType: item.validation.detectedMimeType ?? null,
            uploadByteLength: item.validation.byteLength,
          },
        },
      });
      // The version row is already committed at this point. An enqueue failure
      // here must not be lost or abort the rest of a multi-file upload: mark
      // this version parse_failed (Reprocess can retry it) and keep looping.
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
      writeDocumentAudit({
        scope,
        actor: ctx.userId,
        documentId: result.document.id,
        versionId: result.version.id,
        action: "documents.uploaded",
        message: `Uploaded ${result.document.documentName} version ${result.version.versionNumber}.`,
        details: {
          byteSize: result.version.byteSize,
          fileFormat: result.version.fileFormat,
          storageCreated: stored.created,
          queueError: queueError ?? null,
        },
      });
      uploads.push({
        documentId: result.document.id,
        versionId: result.version.id,
        jobId: queued?.job.id ?? null,
        document: result.document,
        version: result.version,
        job: queued?.job ?? null,
        reused: queued?.reused ?? false,
        duplicateContentMatches: result.duplicateContentMatches,
        queueError: queueError ?? null,
      });
    }

    return NextResponse.json({ uploads }, { status: 202 });
  } catch (error) {
    if (isDocumentIngestUnavailableError(error)) {
      return NextResponse.json(
        { error: DOCUMENT_INGEST_UNAVAILABLE_MESSAGE, code: DOCUMENT_INGEST_UNAVAILABLE_CODE },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    return documentAuthOrErrorResponse(error, "The document upload could not be completed.");
  } finally {
    if (multipart) await removeStreamedDocumentMultipart(multipart).catch(() => undefined);
  }
}

async function validateUploadedFiles(files: StreamedDocumentUpload[]) {
  const result: Array<{ file: StreamedDocumentUpload; validation: ValidatedDocumentUpload }> = [];
  for (const file of files) {
    const data = await readFile(file.tempPath);
    if (data.byteLength !== file.byteSize) throw new Error("The temporary upload size changed before validation.");
    const validation = await validateDocumentUpload({
      fileName: file.originalFileName,
      data,
      declaredMimeType: file.mimeType,
    });
    result.push({ file, validation });
  }
  return result;
}

function canonicalMimeType(validation: ValidatedDocumentUpload) {
  switch (validation.format) {
    case "pdf": return "application/pdf";
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "csv": return "text/csv";
    case "txt": return "text/plain";
    case "md": return "text/markdown";
  }
}

function writeDocumentAudit(input: {
  scope: { workspaceId?: string; projectId: string; azureProjectId: string; azureProjectName: string; azureOrganizationUrl: string };
  actor: string;
  documentId: string;
  versionId: string;
  action: string;
  message: string;
  details: Record<string, unknown>;
}) {
  writeAuditLog({
    workspaceId: input.scope.workspaceId,
    projectId: input.scope.projectId,
    azureProjectId: input.scope.azureProjectId,
    azureProjectName: input.scope.azureProjectName,
    azureOrganizationUrl: input.scope.azureOrganizationUrl,
    entityType: "project_source_document",
    entityId: input.documentId,
    action: input.action,
    status: "Success",
    actor: input.actor,
    message: input.message,
    details: { documentId: input.documentId, versionId: input.versionId, ...input.details },
  });
}
