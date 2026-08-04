import { Readable } from "node:stream";
import { NextResponse } from "next/server";

import { getDocumentStorageBackend } from "@/modules/documents/document-storage.service";
import { getProjectSourceDocumentVersion } from "@/modules/documents/project-source-documents.service";

import {
  documentAuthOrErrorResponse,
  documentDownloadHeaders,
  parseDocumentScopeParam,
  resolveDocumentReadScope,
} from "../../../document-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ versionId: string }> };

/** Immutable-version download: provenance links never silently switch bytes. */
export async function GET(request: Request, { params }: RouteParams) {
  const scopeInput = parseDocumentScopeParam(new URL(request.url).searchParams.get("scope"));
  if (!scopeInput.success) return NextResponse.json({ error: scopeInput.error }, { status: 400 });

  try {
    const { scope } = await resolveDocumentReadScope(scopeInput.data);
    const { versionId } = await params;
    const version = await getProjectSourceDocumentVersion({ scope, versionId });
    if (!version) return NextResponse.json({ error: "The requested document version was not found in the selected project." }, { status: 404 });
    const storage = getDocumentStorageBackend();
    if (storage.kind !== version.storageBackend) {
      return NextResponse.json({ error: "The storage backend for this document version is unavailable." }, { status: 503 });
    }
    const stream = await storage.getStream({ storageKey: version.storageKey });
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      headers: documentDownloadHeaders({ fileName: version.originalFileName, byteSize: version.byteSize }),
    });
  } catch (error) {
    return documentAuthOrErrorResponse(error, "The document version could not be downloaded.");
  }
}
