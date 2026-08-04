import {
  ProjectKnowledgeBaseSchema,
  renderProjectKnowledgeEvidenceRefs,
  sortProjectKnowledgeEvidenceRefs,
  type ProjectKnowledgeBase,
  type ProjectKnowledgeEvidenceRef,
} from "./project-knowledge.schema";
import {
  normalizeProjectKnowledgeSourceWhitespace,
  projectKnowledgeSourceFieldText,
} from "./project-knowledge-source-text";

export type ProjectKnowledgeEvidenceSnapshot = {
  id: string;
  sourceWorkItemId: string;
  fields: Record<string, unknown>;
};

export type ProjectKnowledgeDocumentEvidenceChunk = {
  id: string;
  sourceDocumentId: string;
  sourceDocumentVersionId: string;
  content: string;
  /** Preserves the stricter M3 image/OCR review gate when those chunks arrive. */
  verification?: ProjectKnowledgeEvidenceRef["verification"];
};

export type ProjectKnowledgeEvidenceBlocker = {
  type:
    | "quote_mismatch"
    | "snapshot_missing"
    | "work_item_mismatch"
    | "source_field_missing"
    | "document_chunk_missing"
    | "document_mismatch"
    | "document_version_mismatch";
  category: string;
  entryKey: string;
  sourceKind: ProjectKnowledgeEvidenceRef["sourceKind"];
  sourceSnapshotId?: string;
  sourceWorkItemId?: string;
  sourceDocumentId?: string;
  sourceDocumentVersionId?: string;
  sourceField: string;
  message: string;
};

export function verifyProjectKnowledgeEvidence(input: {
  knowledgeBase: ProjectKnowledgeBase;
  snapshots: ProjectKnowledgeEvidenceSnapshot[];
  documentChunks?: ProjectKnowledgeDocumentEvidenceChunk[];
}) {
  const knowledgeBase = structuredClone(ProjectKnowledgeBaseSchema.parse(input.knowledgeBase));
  const snapshots = new Map(input.snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const documentChunks = new Map((input.documentChunks ?? []).map((chunk) => [documentChunkKey(
    chunk.sourceDocumentVersionId,
    chunk.id,
  ), chunk]));
  const blockers: ProjectKnowledgeEvidenceBlocker[] = [];
  const warnings: ProjectKnowledgeEvidenceBlocker[] = [];
  const counts = {
    exact: 0,
    normalized: 0,
    autoReanchored: 0,
    mismatch: 0,
  };

  for (const entry of allKnowledgeEntries(knowledgeBase)) {
    const refs = entry.value.evidenceRefs ?? [];
    if (!refs.length) continue;
    const verifiedRefs = refs.map((ref) => {
      const result = ref.sourceKind === "document"
        ? verifyDocumentEvidenceRef(ref, documentChunks)
        : verifyWorkItemEvidenceRef(ref, snapshots.get(ref.sourceSnapshotId ?? ""));
      if (result.ref.verification === "exact") counts.exact += 1;
      if (result.ref.verification === "normalized") counts.normalized += 1;
      if (result.ref.verification === "auto_reanchored") counts.autoReanchored += 1;
      if (result.issue) {
        counts.mismatch += 1;
        const issue = {
          ...result.issue,
          category: entry.category,
          entryKey: entry.entryKey,
        };
        if (["generated_v2", "generated_v4", "reviewer_reanchored"].includes(ref.origin)) blockers.push(issue);
        else warnings.push(issue);
      }
      return result.ref;
    });
    entry.value.evidenceRefs = sortProjectKnowledgeEvidenceRefs(verifiedRefs);
    entry.value.sourceWorkItemIds = Array.from(new Set(
      entry.value.evidenceRefs.flatMap((ref) =>
        ref.sourceKind === "work_item" && ref.sourceWorkItemId ? [ref.sourceWorkItemId] : []),
    ));
    entry.value.evidence = renderProjectKnowledgeEvidenceRefs(entry.value.evidenceRefs);
  }

  return {
    knowledgeBase: ProjectKnowledgeBaseSchema.parse(knowledgeBase),
    blockers,
    warnings,
    counts,
  };
}

function verifyWorkItemEvidenceRef(
  ref: ProjectKnowledgeEvidenceRef,
  snapshot: ProjectKnowledgeEvidenceSnapshot | undefined,
): { ref: ProjectKnowledgeEvidenceRef; issue?: Omit<ProjectKnowledgeEvidenceBlocker, "category" | "entryKey"> } {
  if (!snapshot) return unresolved(ref, "snapshot_missing", "The cited immutable source snapshot does not exist.");
  if (snapshot.sourceWorkItemId !== ref.sourceWorkItemId) {
    return unresolved(ref, "work_item_mismatch", "The snapshot belongs to a different source work item.");
  }

  const fieldValue = projectKnowledgeSourceFieldText(snapshot.fields, ref.sourceField);
  if (!fieldValue) return unresolved(ref, "source_field_missing", "The cited strict source field is empty or missing.");
  return verifyQuoteAgainstText(ref, fieldValue);
}

function verifyDocumentEvidenceRef(
  ref: ProjectKnowledgeEvidenceRef,
  chunks: Map<string, ProjectKnowledgeDocumentEvidenceChunk>,
): { ref: ProjectKnowledgeEvidenceRef; issue?: Omit<ProjectKnowledgeEvidenceBlocker, "category" | "entryKey"> } {
  const chunkId = typeof ref.locator?.documentChunkId === "string" ? ref.locator.documentChunkId.trim() : "";
  if (!chunkId || !ref.sourceDocumentVersionId) {
    return unresolved(ref, "document_chunk_missing", "The cited immutable document chunk does not exist.");
  }
  const chunk = chunks.get(documentChunkKey(ref.sourceDocumentVersionId, chunkId));
  if (!chunk) return unresolved(ref, "document_chunk_missing", "The cited immutable document chunk does not exist.");
  if (chunk.sourceDocumentId !== ref.sourceDocumentId) {
    return unresolved(ref, "document_mismatch", "The cited chunk belongs to a different document.");
  }
  if (chunk.sourceDocumentVersionId !== ref.sourceDocumentVersionId) {
    return unresolved(ref, "document_version_mismatch", "The cited chunk belongs to a different document version.");
  }

  const result = verifyQuoteAgainstText(ref, chunk.content);
  // OCR/vision-derived chunks intentionally cannot be upgraded by quote matching:
  // their unverified status is the automatic-publication safety gate.
  if (ref.verification === "unverified" || chunk.verification === "unverified") {
    return { ...result, ref: { ...result.ref, verification: "unverified" } };
  }
  return result;
}

function verifyQuoteAgainstText(
  ref: ProjectKnowledgeEvidenceRef,
  fieldValue: string,
): { ref: ProjectKnowledgeEvidenceRef; issue?: Omit<ProjectKnowledgeEvidenceBlocker, "category" | "entryKey"> } {
  if (fieldValue.includes(ref.quote)) return { ref: { ...ref, verification: "exact" } };
  if (normalizeProjectKnowledgeSourceWhitespace(fieldValue).includes(normalizeProjectKnowledgeSourceWhitespace(ref.quote))) {
    return { ref: { ...ref, verification: "normalized" } };
  }

  const reanchoredQuote = uniqueTokenReanchor(fieldValue, ref.quote);
  if (reanchoredQuote) {
    return {
      ref: {
        ...ref,
        quote: reanchoredQuote,
        verification: "auto_reanchored",
      },
    };
  }

  return unresolved(ref, "quote_mismatch", "The quote does not resolve uniquely in the cited source field.");
}

function unresolved(
  ref: ProjectKnowledgeEvidenceRef,
  type: ProjectKnowledgeEvidenceBlocker["type"],
  message: string,
) {
  return {
    ref: { ...ref, verification: "unverified" as const },
    issue: {
      type,
      sourceKind: ref.sourceKind,
      ...(ref.sourceSnapshotId ? { sourceSnapshotId: ref.sourceSnapshotId } : {}),
      ...(ref.sourceWorkItemId ? { sourceWorkItemId: ref.sourceWorkItemId } : {}),
      ...(ref.sourceDocumentId ? { sourceDocumentId: ref.sourceDocumentId } : {}),
      ...(ref.sourceDocumentVersionId ? { sourceDocumentVersionId: ref.sourceDocumentVersionId } : {}),
      sourceField: ref.sourceField,
      message,
    },
  };
}

function documentChunkKey(sourceDocumentVersionId: string, chunkId: string) {
  return `${sourceDocumentVersionId}\u0000${chunkId}`;
}

function uniqueTokenReanchor(fieldValue: string, quote: string) {
  const insignificant = new Set(["a", "an", "the"]);
  const quoteTokens = Array.from(quote.matchAll(/[\p{L}\p{N}]+/gu))
    .map((match) => match[0].toLowerCase())
    .filter((token) => !insignificant.has(token));
  if (quoteTokens.length < 3) return null;

  const fieldTokens = Array.from(fieldValue.matchAll(/[\p{L}\p{N}]+/gu))
    .map((match) => ({
      value: match[0].toLowerCase(),
      start: match.index,
      end: (match.index ?? 0) + match[0].length,
    }))
    .filter((token) => !insignificant.has(token.value));
  const matches: string[] = [];
  for (let index = 0; index <= fieldTokens.length - quoteTokens.length; index += 1) {
    const candidate = fieldTokens.slice(index, index + quoteTokens.length);
    if (candidate.every((token, tokenIndex) => token.value === quoteTokens[tokenIndex])) {
      matches.push(fieldValue.slice(candidate[0].start, candidate[candidate.length - 1].end).trim());
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function allKnowledgeEntries(knowledgeBase: ProjectKnowledgeBase) {
  return [
    ...knowledgeBase.modules.map((value) => ({ category: "module", entryKey: value.id, value })),
    ...knowledgeBase.businessRules.map((value) => ({ category: "business_rule", entryKey: value.id, value })),
    ...knowledgeBase.stateTransitions.map((value) => ({ category: "state_transition", entryKey: value.id, value })),
    ...knowledgeBase.glossary.map((value) => ({ category: "glossary", entryKey: value.term, value })),
    ...knowledgeBase.crossDependencies.map((value) => ({ category: "dependency", entryKey: value.id, value })),
  ];
}
