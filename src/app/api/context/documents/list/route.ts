import { NextResponse } from "next/server";
import { z } from "zod";

import { listProjectSourceDocuments } from "@/modules/documents/project-source-documents.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";

import {
  countProjectSourceDocuments,
  documentAuthOrErrorResponse,
  enrichProjectSourceDocumentList,
  parseDocumentListFilters,
  parseDocumentPagination,
  resolveDocumentReadScope,
} from "../document-route-helpers";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  lifecycleStatus: z.enum(["active", "archived"]).optional(),
  search: z.string().optional(),
  page: z.number().int().optional(),
  pageSize: z.number().int().optional(),
}).strict();

/** Canonical JSON list endpoint for clients that should not put scope JSON in a URL. */
export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid document list request and project scope are required." }, { status: 400 });

  const filters = parseDocumentListFilters(parsed.data);
  if (!filters.success) return NextResponse.json({ error: filters.error }, { status: 400 });
  const pagination = parseDocumentPagination({
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });
  if (!pagination.success) return NextResponse.json({ error: pagination.error }, { status: 400 });

  try {
    const { scope } = await resolveDocumentReadScope(parsed.data.scope);
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
