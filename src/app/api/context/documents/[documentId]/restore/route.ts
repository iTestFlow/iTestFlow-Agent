import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { restoreProjectSourceDocument } from "@/modules/documents/project-source-documents.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { refreshProjectContextSearchIndex } from "@/modules/rag/context-chatbot-retrieval.service";
import { markProjectKnowledgeDocumentSourceDrift } from "@/modules/rag/project-knowledge-draft.service";
import { withTransaction } from "@/modules/shared/infrastructure/database/db";

import {
  documentAuthOrErrorResponse,
  resolveDocumentMutationScope,
} from "../../document-route-helpers";

export const runtime = "nodejs";

type RouteParams = { params: Promise<{ documentId: string }> };

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  reason: z.string().trim().max(2_000).optional(),
}).strict();

export async function POST(request: Request, { params }: RouteParams) {
  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required to restore a document." }, { status: 400 });

  try {
    const { ctx, scope } = await resolveDocumentMutationScope(
      parsed.data.scope,
      "Only workspace owners and admins can restore source documents.",
    );
    const { documentId } = await params;
    // Restoring makes the document eligible for the next compile rather than
    // trusting stale prior claims; index and knowledge state change atomically.
    const { document, impact } = await withTransaction(async (client) => {
      const document = await restoreProjectSourceDocument({ scope, documentId, client });
      const impact = await markProjectKnowledgeDocumentSourceDrift({
        scope,
        documentId: document.id,
        action: "restored",
        client,
      });
      await refreshProjectContextSearchIndex({ scope }, client);
      return { document, impact };
    });
    writeAuditLog({
      workspaceId: ctx.workspace.id,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      azureProjectName: scope.azureProjectName,
      azureOrganizationUrl: scope.azureOrganizationUrl,
      entityType: "project_source_document",
      entityId: document.id,
      action: "documents.restored",
      status: "Success",
      actor: ctx.userId,
      message: `Restored ${document.documentName}.`,
      details: { reason: parsed.data.reason ?? null, impactedKnowledgeEntries: impact.totalEntries },
    });
    return NextResponse.json({ document, impact });
  } catch (error) {
    return documentAuthOrErrorResponse(error, "The source document could not be restored.");
  }
}
