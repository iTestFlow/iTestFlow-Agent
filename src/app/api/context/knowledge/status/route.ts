import { NextResponse } from "next/server";
import { z } from "zod";
import { authErrorResponse, requireWorkflowContext } from "@/modules/credentials/scoped-resolution.service";
import { getProjectSourceDocumentDisplayInfo } from "@/modules/documents/project-source-documents.service";
import { PROJECT_KNOWLEDGE_JOB } from "@/modules/jobs/project-knowledge-jobs.service";
import { hasHealthyWorkerCapability } from "@/modules/jobs/worker-registry.service";
import { ProjectScopeSchema } from "@/modules/projects/project-isolation.guard";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { getLatestInReviewProjectKnowledgeDraft } from "@/modules/rag/project-knowledge-draft.service";
import { getProjectKnowledgeBaseSnapshot } from "@/modules/rag/project-knowledge.service";
import type { ProjectKnowledgeBase } from "@/modules/rag/project-knowledge.schema";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
});

/**
 * Provenance evidence refs deliberately store only `sourceDocumentId`/
 * `sourceDocumentVersionId` (see project-knowledge.schema.ts) -- never names,
 * since a rename must not go stale in already-hashed provenance. This
 * collects the distinct ids across every category so the caller can
 * batch-resolve current display names at read time.
 */
function collectProjectKnowledgeBaseDocumentIds(knowledgeBase: ProjectKnowledgeBase | undefined) {
  const documentIds = new Set<string>();
  const versionIds = new Set<string>();
  const categories = [
    knowledgeBase?.modules ?? [],
    knowledgeBase?.businessRules ?? [],
    knowledgeBase?.stateTransitions ?? [],
    knowledgeBase?.glossary ?? [],
    knowledgeBase?.crossDependencies ?? [],
  ];
  for (const category of categories) {
    for (const entry of category) {
      for (const evidence of entry.evidenceRefs ?? []) {
        if (evidence.sourceDocumentId) documentIds.add(evidence.sourceDocumentId);
        if (evidence.sourceDocumentVersionId) versionIds.add(evidence.sourceDocumentVersionId);
      }
    }
  }
  return { documentIds: Array.from(documentIds), versionIds: Array.from(versionIds) };
}

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before loading the knowledge base." }, { status: 400 });
  }

  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    const trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const [snapshot, generationAvailable, latestInReviewDraft] = await Promise.all([
      getProjectKnowledgeBaseSnapshot({ scope: trustedScope }),
      hasHealthyWorkerCapability(PROJECT_KNOWLEDGE_JOB),
      getLatestInReviewProjectKnowledgeDraft({ scope: trustedScope }),
    ]);
    const { documentIds, versionIds } = snapshot
      ? collectProjectKnowledgeBaseDocumentIds(snapshot.knowledgeBase)
      : { documentIds: [], versionIds: [] };
    // Most projects cite no documents; skip the lookup entirely on this polled
    // endpoint rather than paying a per-poll no-op service round trip.
    const { documentNames, versionNumbers } = documentIds.length || versionIds.length
      ? await getProjectSourceDocumentDisplayInfo({ scope: trustedScope, documentIds, versionIds })
      : { documentNames: new Map<string, string>(), versionNumbers: new Map<string, number>() };
    return NextResponse.json({
      snapshot,
      generationAvailable,
      latestInReviewDraft,
      documentDisplayNames: {
        documentNames: Object.fromEntries(documentNames),
        documentVersionNumbers: Object.fromEntries(versionNumbers),
      },
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    return routeErrorResponse(error, { domain: "generic", status: 503, fallback: "Project knowledge status failed." });
  }
}
