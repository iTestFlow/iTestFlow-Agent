/**
 * The persisted chunk discriminator and the public context-source discriminator
 * deliberately use the same two values.  Embeddings use a separate discriminator
 * (see `embeddingSourceTypeForContextSource`) so the independent pipelines sharing
 * `embeddings` cannot clean each other up.
 */
export const PROJECT_CONTEXT_SOURCE_KINDS = ["azure_work_item", "uploaded_document"] as const;

export type ProjectContextSourceKind = (typeof PROJECT_CONTEXT_SOURCE_KINDS)[number];

export function normalizeProjectContextSourceKinds(
  sourceKinds: readonly ProjectContextSourceKind[] | undefined,
): ProjectContextSourceKind[] {
  if (!sourceKinds?.length) return [...PROJECT_CONTEXT_SOURCE_KINDS];
  const supported = new Set<ProjectContextSourceKind>(PROJECT_CONTEXT_SOURCE_KINDS);
  const normalized = Array.from(new Set(sourceKinds.filter((kind) => supported.has(kind))));
  return normalized.length ? normalized : [...PROJECT_CONTEXT_SOURCE_KINDS];
}

export function embeddingSourceTypeForContextSource(sourceType: ProjectContextSourceKind) {
  return sourceType === "azure_work_item" ? "azure_work_item_chunk" : "uploaded_document_chunk";
}

/** A collision-safe identity for capping and de-duplicating chunks from one source. */
export function projectContextLogicalSourceKey(input: {
  sourceType: ProjectContextSourceKind | string;
  azureWorkItemId?: string | null;
  documentId?: string | null;
}): string {
  const sourceId = input.sourceType === "uploaded_document"
    ? input.documentId
    : input.azureWorkItemId;
  return `${input.sourceType}\u0000${sourceId ?? "__missing_source_id__"}`;
}
