import "server-only";

import type { RagChunk, RagSearchResult, VectorStore } from "./rag-types";

/**
 * Placeholder VectorStore implementation, not used by any production retrieval path.
 * Production retrieval is Postgres full-text search plus optional embedding-based
 * semantic search (embedding-store.service.ts). This in-memory keyword store only
 * exercises the VectorStore port, kept for a future pluggable vector backend such
 * as pgvector. See docs/knowledge-wiki-rag-enhancement.md.
 */
export class LocalKeywordVectorStore implements VectorStore {
  private chunks: RagChunk[] = [];

  async upsert(chunks: RagChunk[]) {
    const keys = new Set(chunks.map((chunk) => chunk.id));
    this.chunks = this.chunks.filter((chunk) => !keys.has(chunk.id)).concat(chunks);
  }

  async search(input: {
    projectId: string;
    azureProjectId: string;
    query: string;
    topK: number;
  }): Promise<RagSearchResult[]> {
    const terms = tokenize(input.query);
    return this.chunks
      .filter((chunk) => chunk.projectId === input.projectId && chunk.azureProjectId === input.azureProjectId)
      .map((chunk) => ({ ...chunk, score: scoreChunk(chunk.content, terms) }))
      .filter((chunk) => chunk.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, input.topK);
  }
}

function tokenize(value: string) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
}

function scoreChunk(content: string, terms: string[]) {
  const haystack = content.toLowerCase();
  if (!terms.length) return 0;
  const hits = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
  return Math.round((hits / terms.length) * 100) / 100;
}
