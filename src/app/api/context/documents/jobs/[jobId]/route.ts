import { NextResponse } from "next/server";

import { writeAuditLog } from "@/modules/audit/audit.service";
import {
  cancelUploadedDocumentIngestJob,
  getUploadedDocumentIngestJob,
} from "@/modules/jobs/uploaded-document-jobs.service";

import {
  documentAuthOrErrorResponse,
  parseDocumentScopeParam,
  resolveDocumentMutationScope,
  resolveDocumentReadScope,
} from "../../document-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  return readOrCancelJob(request, params, false);
}

export async function DELETE(request: Request, { params }: RouteParams) {
  return readOrCancelJob(request, params, true);
}

async function readOrCancelJob(request: Request, params: Promise<{ jobId: string }>, cancel: boolean) {
  const scopeInput = parseDocumentScopeParam(new URL(request.url).searchParams.get("scope"));
  if (!scopeInput.success) return NextResponse.json({ error: scopeInput.error }, { status: 400 });

  try {
    const { ctx, scope } = cancel
      ? await resolveDocumentMutationScope(
        scopeInput.data,
        "Only workspace owners and admins can cancel document-ingestion jobs.",
      )
      : await resolveDocumentReadScope(scopeInput.data);
    const { jobId } = await params;
    const job = cancel
      ? await cancelUploadedDocumentIngestJob({ id: jobId, workspaceId: ctx.workspace.id, projectId: scope.projectId })
      : await getUploadedDocumentIngestJob({ id: jobId, workspaceId: ctx.workspace.id, projectId: scope.projectId });
    if (!job) {
      return NextResponse.json({ error: "The document-ingestion job was not found in the selected project." }, { status: 404 });
    }
    if (cancel) {
      writeAuditLog({
        workspaceId: ctx.workspace.id,
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
        azureOrganizationUrl: scope.azureOrganizationUrl,
        entityType: "project_source_document_version",
        entityId: job.versionId ?? job.id,
        action: "documents.ingest_job_cancelled",
        status: "Success",
        actor: ctx.userId,
        message: `Requested cancellation of the document-ingestion job for version ${job.versionId ?? job.id}.`,
        details: { jobId: job.id, status: job.status },
      });
    }
    return NextResponse.json({ job });
  } catch (error) {
    return documentAuthOrErrorResponse(error, "The document-ingestion job could not be loaded.");
  }
}
