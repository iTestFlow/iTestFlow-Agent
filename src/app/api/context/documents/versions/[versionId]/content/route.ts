import { NextResponse } from "next/server";

import {
  getProjectSourceDocumentVersion,
  listProjectSourceDocumentChunks,
} from "@/modules/documents/project-source-documents.service";

import {
  countProjectSourceDocumentVersionChunks,
  documentAuthOrErrorResponse,
  DOCUMENT_CONTENT_PAGE_SIZE_DEFAULT,
  DOCUMENT_CONTENT_PAGE_SIZE_MAX,
  parseDocumentPagination,
  parseDocumentScopeParam,
  resolveDocumentReadScope,
} from "../../../document-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ versionId: string }> };

/** Paged parsed-text preview for one immutable source version. */
export async function GET(request: Request, { params }: RouteParams) {
  const url = new URL(request.url);
  const scopeInput = parseDocumentScopeParam(url.searchParams.get("scope"));
  if (!scopeInput.success) return NextResponse.json({ error: scopeInput.error }, { status: 400 });
  const pagination = parseDocumentPagination({
    page: url.searchParams.get("page"),
    pageSize: url.searchParams.get("pageSize"),
    defaultPageSize: DOCUMENT_CONTENT_PAGE_SIZE_DEFAULT,
    maxPageSize: DOCUMENT_CONTENT_PAGE_SIZE_MAX,
  });
  if (!pagination.success) return NextResponse.json({ error: pagination.error }, { status: 400 });

  try {
    const { scope } = await resolveDocumentReadScope(scopeInput.data);
    const { versionId } = await params;
    const version = await getProjectSourceDocumentVersion({ scope, versionId });
    if (!version) return NextResponse.json({ error: "The requested document version was not found in the selected project." }, { status: 404 });
    const [chunks, totalCount] = await Promise.all([
      listProjectSourceDocumentChunks({
        scope,
        documentId: version.documentId,
        sourceDocumentVersionId: version.id,
        limit: pagination.data.pageSize,
        offset: pagination.data.offset,
      }),
      countProjectSourceDocumentVersionChunks({
        scope,
        documentId: version.documentId,
        versionId: version.id,
      }),
    ]);
    return NextResponse.json({
      version,
      chunks,
      items: chunks,
      totalCount,
      page: pagination.data.page,
      pageSize: pagination.data.pageSize,
      totalPages: Math.max(1, Math.ceil(totalCount / pagination.data.pageSize)),
    });
  } catch (error) {
    return documentAuthOrErrorResponse(error, "The parsed document content could not be loaded.");
  }
}
