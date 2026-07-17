export type RagSourceType = "azure_work_item" | "uploaded_document" | "linked_test_case" | "business_rule" | "api_document";

export type RagChunk = {
  id: string;
  projectId: string;
  azureProjectId: string;
  sourceType: RagSourceType;
  sourceId?: string;
  title?: string;
  content: string;
  metadata: {
    azureProjectName?: string;
    azureWorkItemId?: string;
    workItemType?: string;
    documentName?: string;
    documentType?: string;
    section?: string;
    pageNumber?: number;
    chunkIndex: number;
  };
};

export type RagSearchResult = RagChunk & {
  score: number;
};

/**
 * Port for a future pluggable vector backend (e.g. pgvector). No production code
 * path uses it yet: production retrieval is Postgres full-text search plus the
 * optional embedding-based semantic search in embedding-store.service.ts.
 */
export interface VectorStore {
  upsert(chunks: RagChunk[]): Promise<void>;
  search(input: {
    projectId: string;
    azureProjectId: string;
    query: string;
    topK: number;
  }): Promise<RagSearchResult[]>;
}
