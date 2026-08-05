import { NextResponse } from "next/server";

import { listProjectSourceDocuments } from "@/modules/documents/project-source-documents.service";

import {
  countProjectSourceDocuments,
  documentAuthOrErrorResponse,
  enrichProjectSourceDocumentList,
  parseDocumentListFilters,
  parseDocumentPagination,
  parseDocumentScopeParam,
  resolveDocumentReadScope,
} from "./document-route-helpers";

export const runtime = "nodejs";

/**
 * Reads are deliberately scope-bound even though documents use opaque ids. A
 * caller must prove workspace membership and a valid project anchor before the
 * service sees any document query.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const scopeInput = parseDocumentScopeParam(url.searchParams.get("scope"));
  if (!scopeInput.success) return NextResponse.json({ error: scopeInput.error }, { status: 400 });

  const filters = parseDocumentListFilters({
    lifecycleStatus: url.searchParams.get("lifecycleStatus"),
    search: url.searchParams.get("search"),
  });
  if (!filters.success) return NextResponse.json({ error: filters.error }, { status: 400 });

  const pagination = parseDocumentPagination({
    page: url.searchParams.get("page"),
    pageSize: url.searchParams.get("pageSize"),
  });
  if (!pagination.success) return NextResponse.json({ error: pagination.error }, { status: 400 });

  try {
    const { scope } = await resolveDocumentReadScope(scopeInput.data);
    const [documents, totalCount] = await Promise.all([
      listProjectSourceDocuments({
        scope,
        lifecycleStatus: filters.data.lifecycleStatus,
        search: filters.data.search,
        limit: pagination.data.pageSize,
        offset: pagination.data.offset,
      }),
      countProjectSourceDocuments({ scope, filters: filters.data }),
    ]);
    const items = await enrichProjectSourceDocumentList({ scope, documents });
    return NextResponse.json({
      documents: items,
      // `items` gives generic collection clients a consistent field without
      // making the Documents Hub change its established `documents` contract.
      items,
      totalCount,
      page: pagination.data.page,
      pageSize: pagination.data.pageSize,
      totalPages: Math.max(1, Math.ceil(totalCount / pagination.data.pageSize)),
    });
  } catch (error) {
    return documentAuthOrErrorResponse(error, "Documents could not be loaded.");
  }
}
