import { NextResponse } from "next/server";
import { z } from "zod";

import { writeAuditLog } from "@/modules/audit/audit.service";
import { archiveProjectSourceDocument } from "@/modules/documents/project-source-documents.service";
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
  if (!parsed.success) return NextResponse.json({ error: "A valid project scope is required to archive a document." }, { status: 400 });

  try {
    const { ctx, scope } = await resolveDocumentMutationScope(
      parsed.data.scope,
      "Only workspace owners and admins can archive source documents.",
    );
    const { documentId } = await params;
    // The source registry, derived full-text index, and knowledge freshness are
    // one transaction: no committed archive can remain retrievable or leave a
    // compiled claim looking current.
    const { document, impact } = await withTransaction(async (client) => {
      const document = await archiveProjectSourceDocument({
        scope,
        documentId,
        archivedBy: ctx.userId,
        reason: parsed.data.reason,
        client,
      });
      const impact = await markProjectKnowledgeDocumentSourceDrift({
        scope,
        documentId: document.id,
        action: "archived",
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
      action: "documents.archived",
      status: "Success",
      actor: ctx.userId,
      message: `Archived ${document.documentName}.`,
      details: { reason: parsed.data.reason ?? null, impactedKnowledgeEntries: impact.totalEntries },
    });
    return NextResponse.json({ document, impact });
  } catch (error) {
    return documentAuthOrErrorResponse(error, "The source document could not be archived.");
  }
}
