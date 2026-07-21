import "server-only";

import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { RagChunk, VectorStore } from "./rag-types";

export function chunkText(input: {
  projectId: string;
  azureProjectId: string;
  sourceId: string;
  sourceType: RagChunk["sourceType"];
  title: string;
  text: string;
  chunkSize?: number;
  chunkOverlap?: number;
}): RagChunk[] {
  const size = input.chunkSize ?? 2000;
  // Consecutive chunks share an overlap window so a sentence straddling a chunk
  // boundary stays intact in at least one chunk. Default: 10% of the chunk size,
  // capped at 200 chars; always at least 1 char smaller than the chunk so the
  // window advances.
  const requestedOverlap = input.chunkOverlap ?? Math.min(200, Math.floor(size * 0.1));
  const overlap = Math.min(Math.max(Math.trunc(requestedOverlap), 0), size - 1);
  const step = size - overlap;
  const chunks: RagChunk[] = [];
  for (let index = 0; index < input.text.length; index += step) {
    chunks.push({
      id: `${input.sourceId}-${chunks.length}`,
      projectId: input.projectId,
      azureProjectId: input.azureProjectId,
      sourceId: input.sourceId,
      sourceType: input.sourceType,
      title: input.title,
      content: input.text.slice(index, index + size),
      metadata: { chunkIndex: chunks.length },
    });
    // Once a chunk reaches the end of the text, stop: a further step would emit a
    // trailing chunk that is a pure subset of this one.
    if (index + size >= input.text.length) break;
  }
  return chunks;
}

export async function indexProjectContext(input: {
  scope: ProjectScope;
  actor: string;
  vectorStore: VectorStore;
  chunks: RagChunk[];
}) {
  const scope = assertProjectScope(input.scope);
  const invalid = input.chunks.find((chunk) => chunk.projectId !== scope.projectId || chunk.azureProjectId !== scope.azureProjectId);
  if (invalid) throw new Error("Cannot index chunks outside the selected Azure DevOps project.");

  await input.vectorStore.upsert(input.chunks);
  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "rag.index_project_context",
    status: "Success",
    message: `Indexed ${input.chunks.length} project-scoped chunks.`,
  });
}

export async function retrieveProjectContext(input: {
  scope: ProjectScope;
  vectorStore: VectorStore;
  query: string;
  topK?: number;
}) {
  const scope = assertProjectScope(input.scope);
  return input.vectorStore.search({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    query: input.query,
    topK: input.topK ?? 8,
  });
}
