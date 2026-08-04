import { NextResponse } from "next/server";
import { z } from "zod";

import { getProjectSourceDocument } from "@/modules/documents/project-source-documents.service";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getProjectKnowledgeDocumentImpact } from "@/modules/rag/project-knowledge-draft.service";

import {
  documentAuthOrErrorResponse,
  parseDocumentScopeParam,
  resolveDocumentReadScope,
} from "../../document-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ documentId: string }> };

const RequestSchema = z.object({ scope: ProjectScopeSchema }).strict();

/** Shows active compiled knowledge entries whose evidence cites this document. */
export async function GET(request: Request, { params }: RouteParams) {
  const scopeInput = parseDocumentScopeParam(new URL(request.url).searchParams.get("scope"));
  if (!scopeInput.success) return NextResponse.json({ error: scopeInput.error }, { status: 400 });
  try {
    const { scope } = await resolveDocumentReadScope(scopeInput.data);
    return await loadImpact(scope, params);
  } catch (error) {
    return documentAuthOrErrorResponse(error, "The source-document impact could not be loaded.");
  }
}

/** Canonical JSON alias for clients that avoid scope JSON in query strings. */
export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required." }, { status: 400 });
  try {
    const { scope } = await resolveDocumentReadScope(parsed.data.scope);
    return await loadImpact(scope, params);
  } catch (error) {
    return documentAuthOrErrorResponse(error, "The source-document impact could not be loaded.");
  }
}

async function loadImpact(scope: ProjectScope, params: Promise<{ documentId: string }>) {
  const { documentId } = await params;
  const document = await getProjectSourceDocument({ scope, documentId });
  if (!document) return NextResponse.json({ error: "The requested source document was not found in the selected project." }, { status: 404 });
  const impact = await getProjectKnowledgeDocumentImpact({ scope, documentId: document.id });
  return NextResponse.json({ document, impact });
}
