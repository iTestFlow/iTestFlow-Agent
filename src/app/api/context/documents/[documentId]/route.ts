import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/modules/audit/audit.service";
import {
  getProjectSourceDocument,
  getProjectSourceDocumentWithVersions,
  listProjectSourceDocumentChunks,
  ProjectSourceDocumentNotFoundError,
  updateProjectSourceDocumentMetadata,
} from "@/modules/documents/project-source-documents.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { refreshProjectContextSearchIndex } from "@/modules/rag/context-chatbot-retrieval.service";
import { markProjectKnowledgeDocumentSourceDrift } from "@/modules/rag/project-knowledge-draft.service";
import { withTransaction } from "@/modules/shared/infrastructure/database/db";

import {
  documentAuthOrErrorResponse,
  parseDocumentScopeParam,
  resolveDocumentReadScope,
  resolveDocumentMutationScope,
} from "../document-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ documentId: string }> };

const MetadataPatchSchema = z.object({
  scope: ProjectScopeSchema,
  documentName: z.string().trim().min(1).max(512).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  languageHint: z.string().trim().max(64).nullable().optional(),
}).strict().refine(
  (value) => (
    value.documentName !== undefined
    || value.description !== undefined
    || value.tags !== undefined
    || value.languageHint !== undefined
  ),
  { message: "Provide at least one document metadata field to update." },
);

/** Fetch a source record with immutable version history and current parsed chunks. */
export async function GET(request: Request, { params }: RouteParams) {
  const scopeInput = parseDocumentScopeParam(new URL(request.url).searchParams.get("scope"));
  if (!scopeInput.success) return NextResponse.json({ error: scopeInput.error }, { status: 400 });

  try {
    const { scope } = await resolveDocumentReadScope(scopeInput.data);
    const { documentId } = await params;
    const result = await getProjectSourceDocumentWithVersions({ scope, documentId });
    if (!result) return NextResponse.json({ error: "The requested source document was not found in the selected project." }, { status: 404 });
    const chunks = result.document.currentVersionId
      ? await listProjectSourceDocumentChunks({
        scope,
        documentId: result.document.id,
        sourceDocumentVersionId: result.document.currentVersionId,
        limit: 250,
      })
      : [];
    return NextResponse.json({
      document: result.document,
      versions: result.versions,
      chunks,
    });
  } catch (error) {
    return documentAuthOrErrorResponse(error, "The source document could not be loaded.");
  }
}

/**
 * Edits registry metadata only. Parsed content and immutable version metadata
 * are intentionally excluded: changing either would break hash-backed
 * provenance. A title change is special because it is duplicated into chunks
 * and the FTS mirror used for retrieval/citation display.
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const parsed = MetadataPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Document metadata is invalid." },
      { status: 400 },
    );
  }

  try {
    const { ctx, scope } = await resolveDocumentMutationScope(
      parsed.data.scope,
      "Only workspace owners and admins can edit source-document metadata.",
    );
    const { documentId } = await params;
    const result = await withTransaction(async (client) => {
      // Lock before comparing so a concurrent title update cannot make the
      // derived-chunk/FTS and knowledge freshness decisions stale.
      const previous = await getProjectSourceDocument({ scope, documentId, client, forUpdate: true });
      if (!previous) {
        throw new ProjectSourceDocumentNotFoundError("document");
      }
      const titleChanged = Boolean(
        previous
        && parsed.data.documentName !== undefined
        && previous.documentName !== parsed.data.documentName,
      );
      const document = await updateProjectSourceDocumentMetadata({
        scope,
        documentId,
        client,
        ...(parsed.data.documentName !== undefined ? { documentName: parsed.data.documentName } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.tags !== undefined ? { tags: parsed.data.tags } : {}),
        ...(parsed.data.languageHint !== undefined ? { languageHint: parsed.data.languageHint } : {}),
      });

      if (!titleChanged) return { document, titleChanged, impact: null };

      // Keep all user-observable derivatives in this transaction: the service
      // has already renamed its chunks; rebuild the FTS mirror and mark any
      // compiled facts citing the document stale before committing the title.
      const impact = await markProjectKnowledgeDocumentSourceDrift({
        scope,
        documentId: document.id,
        action: "metadata_updated",
        client,
      });
      await refreshProjectContextSearchIndex({ scope }, client);
      return { document, titleChanged, impact };
    });

    writeAuditLog({
      workspaceId: ctx.workspace.id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_source_document",
      entityId: result.document.id,
      action: "documents.metadata_updated",
      status: "Success",
      actor: ctx.userId,
      message: `Updated metadata for ${result.document.documentName}.`,
      details: {
        titleChanged: result.titleChanged,
        impactedKnowledgeEntries: result.impact?.totalEntries ?? 0,
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return documentAuthOrErrorResponse(error, "The source document metadata could not be updated.");
  }
}
