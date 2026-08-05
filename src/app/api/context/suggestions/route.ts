import { NextResponse } from "next/server";
import { z } from "zod";
import { ProjectScopeSchema, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import {
  authErrorResponse,
  getUserAzureAdapter,
  getUserLLMProvider,
  requireWorkflowContext,
} from "@/modules/credentials/scoped-resolution.service";
import { writeGenerationFailureAudit } from "@/modules/audit/generation-failure-audit";
import type { ContextSuggestionDocument } from "@/modules/context-selection/context-selection.schema";
import { suggestContextStories } from "@/modules/context-selection/context-selection.service";
import { getContextSuggestionCandidatePoolSize, getContextSuggestionFinalLimit } from "@/modules/context-selection/context-suggestion-sizing";
import {
  isWorkItemLlmContextSource,
  requirementToRetrievalQuery,
  retrieveStoredProjectContext,
  type LlmContextSource,
  type LlmDocumentContextSource,
} from "@/modules/rag/project-context-store.service";
import {
  normalizeProjectContextSourceKinds,
  PROJECT_CONTEXT_SOURCE_KINDS,
} from "@/modules/rag/project-context-source";
import { resolveRetrievalTopK } from "@/modules/rag/retrieval-config";
import { resolveProjectScope } from "@/modules/projects/workspace-projects.service";
import { routeErrorResponse } from "@/modules/shared/errors/route-error-response";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scope: ProjectScopeSchema,
  targetWorkItemId: z.string().min(1),
  query: z.string().optional(),
  /** Defaults to both indexed Azure work items and uploaded documents. */
  sourceKinds: z.array(z.enum(PROJECT_CONTEXT_SOURCE_KINDS)).min(1).max(PROJECT_CONTEXT_SOURCE_KINDS.length).optional(),
});

export async function POST(request: Request) {
  const parsed = RequestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please select an Azure DevOps project before running this action." }, { status: 400 });
  }

  let trustedScope: ProjectScope | undefined;
  let actor: string | undefined;
  try {
    const ctx = await requireWorkflowContext(parsed.data.scope.workspaceId);
    actor = ctx.userId;
    trustedScope = await resolveProjectScope(ctx, parsed.data.scope);
    const adapter = await getUserAzureAdapter(ctx, trustedScope);
    const provider = await getUserLLMProvider(ctx);

    const targetRequirement = await adapter.fetchWorkItemById({
      projectId: trustedScope.azureProjectId,
      workItemId: parsed.data.targetWorkItemId,
    });
    const sourceKinds = normalizeProjectContextSourceKinds(parsed.data.sourceKinds);
    const retrievalTopK = getContextSuggestionFinalLimit(
      await resolveRetrievalTopK({
        workspaceId: ctx.workspace.id,
        query: `${targetRequirement.title}\n${targetRequirement.description ?? ""}`,
      }),
    );
    const candidatePoolSize = getContextSuggestionCandidatePoolSize(retrievalTopK);
    const storedContext = distinctContextSources(
      (await retrieveStoredProjectContext({
        scope: trustedScope,
        query: parsed.data.query?.trim() || requirementToRetrievalQuery(targetRequirement),
        topK: candidatePoolSize,
        sourceKinds,
      })).filter((item) => !isWorkItemLlmContextSource(item) || item.workItemId !== parsed.data.targetWorkItemId),
    ).slice(0, retrievalTopK);
    if (!storedContext.length) {
      return NextResponse.json({
        targetWorkItemId: parsed.data.targetWorkItemId,
        sourceKinds,
        suggestions: [],
        documentSuggestions: [],
        candidates: [],
        rawOutput: null,
        provider: provider.name,
        model: provider.model,
      });
    }
    const result = await suggestContextStories({
      scope: trustedScope,
      actor: ctx.userId,
      provider,
      targetRequirement,
      retrievedContext: storedContext,
      maxContextItems: retrievalTopK,
    });
    const documentSuggestions = rehydrateDocumentSuggestions({
      suggestions: result.validatedOutput.suggestedDocuments ?? [],
      candidates: storedContext,
      limit: retrievalTopK,
    });

    return NextResponse.json({
      targetWorkItemId: parsed.data.targetWorkItemId,
      suggestions: result.validatedOutput.suggestedItems,
      documentSuggestions,
      candidates: storedContext.map(toSuggestionCandidate),
      sourceKinds,
      rawOutput: result.rawOutput,
      provider: result.provider,
      model: result.model,
    });
  } catch (error) {
    const authResponse = authErrorResponse(error);
    if (authResponse) return authResponse;
    if (trustedScope && actor) writeGenerationFailureAudit({ scope: trustedScope, actor, action: "context_selection.suggest", label: "Context suggestion failed.", error });
    return routeErrorResponse(error, { domain: "llm", status: 503, fallback: "Context suggestion failed." });
  }
}

/**
 * Hybrid retrieval returns chunks. A context-suggestion candidate is a source,
 * so collapse repeated chunks without making a document masquerade as a work
 * item. Versions are intentionally part of the document identity: an immutable
 * version can be cited independently by published knowledge.
 */
function distinctContextSources(items: LlmContextSource[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = isWorkItemLlmContextSource(item)
      ? `azure_work_item\u0000${item.workItemId}`
      : `uploaded_document\u0000${item.documentId}\u0000${item.documentVersionId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type SuggestionCandidate =
  | {
      sourceType: "azure_work_item";
      sourceId: string;
      workItemId: string;
      workItemType: string;
      title: string;
      state: string;
      relevanceScore: number;
      excerpt: string;
      citation: {
        sourceType: "project_context";
        sourceId: string;
        title: string;
        workItemId: string;
        workItemType: string;
      };
    }
  | {
      sourceType: "uploaded_document";
      sourceId: string;
      documentId: string;
      documentVersionId: string;
      documentName: string;
      title: string;
      relevanceScore: number;
      excerpt: string;
      citation: {
        sourceType: "uploaded_document";
        sourceId: string;
        title: string;
        documentId: string;
        documentVersionId: string;
        documentName: string;
        section?: string;
        pageNumber?: number;
      };
    };

type DocumentSuggestion = {
  sourceType: "uploaded_document";
  sourceId: string;
  documentId: string;
  documentVersionId: string;
  documentName: string;
  title: string;
  relevanceScore: number;
  reason: string;
  citation: Extract<SuggestionCandidate, { sourceType: "uploaded_document" }>["citation"];
};

function toSuggestionCandidate(item: LlmContextSource): SuggestionCandidate {
  if (isWorkItemLlmContextSource(item)) {
    return {
      sourceType: "azure_work_item",
      sourceId: `WI:${item.workItemId}`,
      workItemId: item.workItemId,
      workItemType: item.workItemType,
      title: item.title,
      state: item.state,
      relevanceScore: item.relevanceScore,
      excerpt: toExcerpt(item.content),
      citation: {
        sourceType: "project_context",
        sourceId: `WI:${item.workItemId}`,
        title: item.title,
        workItemId: item.workItemId,
        workItemType: item.workItemType,
      },
    };
  }

  return {
    sourceType: "uploaded_document",
    sourceId: item.sourceId,
    documentId: item.documentId,
    documentVersionId: item.documentVersionId,
    documentName: item.documentName,
    title: item.title,
    relevanceScore: item.relevanceScore,
    excerpt: toExcerpt(item.content),
    citation: toDocumentCitation(item),
  };
}

/**
 * The provider sees candidate IDs but its response is never trusted as a source
 * of provenance. Match it to an actual retrieved version and reconstruct the
 * citation from that candidate, discarding hallucinated, retired, or mismatched
 * document IDs.
 */
function rehydrateDocumentSuggestions(input: {
  suggestions: ContextSuggestionDocument[];
  candidates: LlmContextSource[];
  limit: number;
}): DocumentSuggestion[] {
  const candidatesByVersion = new Map(
    input.candidates
      .filter((item): item is LlmDocumentContextSource => !isWorkItemLlmContextSource(item))
      .map((item) => [`${item.documentId}\u0000${item.documentVersionId}`, item]),
  );
  const seen = new Set<string>();
  const hydrated: DocumentSuggestion[] = [];

  for (const suggestion of input.suggestions) {
    if (hydrated.length >= input.limit) break;
    const key = `${suggestion.documentId}\u0000${suggestion.documentVersionId}`;
    const candidate = candidatesByVersion.get(key);
    if (!candidate || seen.has(key)) continue;
    seen.add(key);
    hydrated.push({
      sourceType: "uploaded_document",
      sourceId: candidate.sourceId,
      documentId: candidate.documentId,
      documentVersionId: candidate.documentVersionId,
      documentName: candidate.documentName,
      title: candidate.title,
      relevanceScore: suggestion.relevanceScore,
      reason: suggestion.reason,
      citation: toDocumentCitation(candidate),
    });
  }

  return hydrated;
}

function toDocumentCitation(item: LlmDocumentContextSource) {
  return {
    sourceType: "uploaded_document" as const,
    sourceId: item.sourceId,
    title: item.title,
    documentId: item.documentId,
    documentVersionId: item.documentVersionId,
    documentName: item.documentName,
    ...(item.metadata.section ? { section: item.metadata.section } : {}),
    ...(item.metadata.pageNumber ? { pageNumber: item.metadata.pageNumber } : {}),
  };
}

function toExcerpt(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}
