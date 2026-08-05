import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/modules/audit/audit.service";
import {
  getProjectSourceDocument,
  getProjectSourceDocumentVersion,
} from "@/modules/documents/project-source-documents.service";
import {
  DOCUMENT_INGEST_UNAVAILABLE_CODE,
  DOCUMENT_INGEST_UNAVAILABLE_MESSAGE,
  enqueueUploadedDocumentIngestJob,
  isDocumentIngestUnavailableError,
  UPLOADED_DOCUMENT_INGEST,
} from "@/modules/jobs/uploaded-document-jobs.service";
import { hasHealthyWorkerCapability } from "@/modules/jobs/worker-registry.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

import {
  documentAuthOrErrorResponse,
  resolveDocumentMutationScope,
} from "../../document-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ documentId: string }> };

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  // Accepting this lets a client be explicit, but historical versions are not
  // reprocessed because only the registry's current version is retrievable.
  versionId: z.string().trim().min(1).optional(),
}).strict();

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required to reprocess a document." }, { status: 400 });

  try {
    const { ctx, scope } = await resolveDocumentMutationScope(
      parsed.data.scope,
      "Only workspace owners and admins can reprocess source documents.",
    );
    const { documentId } = await params;
    const document = await getProjectSourceDocument({ scope, documentId });
    if (!document) return NextResponse.json({ error: "The requested source document was not found in the selected project." }, { status: 404 });
    if (document.lifecycleStatus !== "active") {
      return NextResponse.json({ error: "Restore the archived document before reprocessing it." }, { status: 409 });
    }
    const versionId = parsed.data.versionId ?? document.currentVersionId;
    if (!versionId) return NextResponse.json({ error: "The source document has no current version to reprocess." }, { status: 409 });
    if (versionId !== document.currentVersionId) {
      return NextResponse.json({ error: "Only the document's current version can be reprocessed into the active corpus." }, { status: 409 });
    }
    const version = await getProjectSourceDocumentVersion({ scope, versionId });
    if (!version || version.documentId !== document.id) {
      return NextResponse.json({ error: "The requested document version was not found in the selected project." }, { status: 404 });
    }
    if (!await hasHealthyWorkerCapability(UPLOADED_DOCUMENT_INGEST)) {
      return NextResponse.json(
        { error: DOCUMENT_INGEST_UNAVAILABLE_MESSAGE, code: DOCUMENT_INGEST_UNAVAILABLE_CODE },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    const queued = await enqueueUploadedDocumentIngestJob({
      scope,
      workspaceId: ctx.workspace.id,
      actor: ctx.userId,
      versionId: version.id,
    });
    writeAuditLog({
      workspaceId: ctx.workspace.id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_source_document_version",
      entityId: version.id,
      action: "documents.reprocess_queued",
      status: "Success",
      actor: ctx.userId,
      message: `Queued reprocessing for ${document.documentName} version ${version.versionNumber}.`,
      details: { documentId: document.id, versionId: version.id, reused: queued.reused },
    });
    return NextResponse.json({ document, version, job: queued.job, reused: queued.reused }, { status: 202 });
  } catch (error) {
    if (isDocumentIngestUnavailableError(error)) {
      return NextResponse.json(
        { error: DOCUMENT_INGEST_UNAVAILABLE_MESSAGE, code: DOCUMENT_INGEST_UNAVAILABLE_CODE },
        { status: 503, headers: { "Retry-After": "5" } },
      );
    }
    return documentAuthOrErrorResponse(error, "The document could not be queued for reprocessing.");
  }
}
