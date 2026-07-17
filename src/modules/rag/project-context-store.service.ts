import "server-only";

import { createId, nowIso, sqlAll, sqlRun, withTransaction } from "@/modules/shared/infrastructure/database/db";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { chunkText } from "./rag-pipeline.service";
import { ensureProjectContextSearchIndex, refreshProjectContextSearchIndex } from "./context-chatbot-retrieval.service";
import { buildFtsQuery } from "./full-text-search";
import { createEmbeddingProvider, type EmbeddingProvider } from "./embedding-provider";
import { searchProjectContextByEmbedding, syncProjectChunkEmbeddings } from "./embedding-store.service";
import { fuseByReciprocalRank } from "./hybrid-ranking";
import { ensureProjectContextSyncSchema } from "./project-context-schema.service";
import { recordProjectKnowledgeLog } from "./project-knowledge-compiled.service";

type CryptoModule = typeof import("crypto");

export type LlmContextSource = {
  sourceType: "azure_work_item";
  workItemId: string;
  workItemType: string;
  state: string;
  title: string;
  content: string;
  relevanceScore: number;
  metadata: {
    areaPath?: string;
    iterationPath?: string;
    tags?: string[];
    updatedDate?: string;
    chunkIndex: number;
  };
};

type ContextChunkRow = {
  id: string;
  azure_work_item_id: string | null;
  work_item_type: string | null;
  document_name: string | null;
  content: string;
  metadata_json: string | null;
};

type RecentContextRow = {
  azure_work_item_id: string;
  work_item_type: string;
  title: string;
  state: string | null;
  sync_status: string | null;
  updated_date: string | null;
  last_synced_at: string | null;
  chunk_count: number;
};

export type ProjectContextSortBy = "lastIndexedAt" | "type" | "state";
export type ProjectContextSortDirection = "asc" | "desc";

const UPSERT_WORK_ITEM_SQL = `
  INSERT INTO azure_devops_work_items (
    id, project_id, azure_project_id, azure_project_name, azure_organization_url,
    azure_work_item_id, work_item_type, title, description, acceptance_criteria,
    state, assigned_to, priority, tags, area_path, iteration_path, raw_json,
    created_date, updated_date, last_synced_at, content_hash, sync_status,
    current_index_run_id, created_at, updated_at
  ) VALUES (
    @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
    @azureWorkItemId, @workItemType, @title, @description, @acceptanceCriteria,
    @state, @assignedTo, @priority, @tags, @areaPath, @iterationPath, @rawJson,
    @createdDate, @updatedDate, @lastSyncedAt, @contentHash, 'active',
    @currentIndexRunId, @createdAt, @updatedAt
  )
  ON CONFLICT(project_id, azure_work_item_id) DO UPDATE SET
    azure_project_id = excluded.azure_project_id,
    azure_project_name = excluded.azure_project_name,
    azure_organization_url = excluded.azure_organization_url,
    work_item_type = excluded.work_item_type,
    title = excluded.title,
    description = excluded.description,
    acceptance_criteria = excluded.acceptance_criteria,
    state = excluded.state,
    assigned_to = excluded.assigned_to,
    priority = excluded.priority,
    tags = excluded.tags,
    area_path = excluded.area_path,
    iteration_path = excluded.iteration_path,
    raw_json = excluded.raw_json,
    created_date = excluded.created_date,
    updated_date = excluded.updated_date,
    last_synced_at = excluded.last_synced_at,
    content_hash = excluded.content_hash,
    sync_status = 'active',
    current_index_run_id = excluded.current_index_run_id,
    updated_at = excluded.updated_at
`;
const MARK_UNCHANGED_WORK_ITEM_SQL = `
  UPDATE azure_devops_work_items
  SET last_synced_at = @lastSyncedAt,
      sync_status = 'active',
      current_index_run_id = @currentIndexRunId,
      updated_at = @updatedAt
  WHERE project_id = @projectId
    AND azure_project_id = @azureProjectId
    AND azure_work_item_id = @azureWorkItemId
`;
const MARK_INACTIVE_WORK_ITEM_SQL = `
  UPDATE azure_devops_work_items
  SET sync_status = 'inactive',
      current_index_run_id = @currentIndexRunId,
      last_synced_at = @lastSyncedAt,
      updated_at = @updatedAt
  WHERE project_id = @projectId
    AND azure_project_id = @azureProjectId
    AND azure_work_item_id = @azureWorkItemId
    AND COALESCE(sync_status, 'active') != 'inactive'
`;
const DELETE_WORK_ITEM_CHUNKS_SQL = `
  DELETE FROM document_chunks
  WHERE project_id = @projectId
    AND azure_project_id = @azureProjectId
    AND source_type = 'azure_work_item'
    AND azure_work_item_id = @azureWorkItemId
`;
const DELETE_PROJECT_CHUNKS_SQL = `
  DELETE FROM document_chunks
  WHERE project_id = @projectId
    AND azure_project_id = @azureProjectId
    AND source_type = 'azure_work_item'
`;
const DELETE_PROJECT_WORK_ITEMS_SQL = `
  DELETE FROM azure_devops_work_items
  WHERE project_id = @projectId
    AND azure_project_id = @azureProjectId
`;
const INSERT_CHUNK_SQL = `
  INSERT INTO document_chunks (
    id, project_id, azure_project_id, azure_project_name, source_type,
    azure_work_item_id, work_item_type, document_name, document_type,
    chunk_index, content, metadata_json, created_at, updated_at
  ) VALUES (
    @id, @projectId, @azureProjectId, @azureProjectName, 'azure_work_item',
    @azureWorkItemId, @workItemType, @documentName, 'azure_work_item',
    @chunkIndex, @content, @metadataJson, @createdAt, @updatedAt
  )
`;

export async function indexAzureWorkItemsAsProjectContext(input: {
  scope: ProjectScope;
  actor: string;
  adapter: AzureDevOpsAdapter;
  workItemTypes: string[];
  states: string[];
  mode?: "incremental" | "rebuild";
}) {
  const scope = assertProjectScope(input.scope);
  ensureProjectContextSyncSchema();
  if (!input.workItemTypes.length) throw new Error("Select at least one work item type to index.");
  if (!input.states.length) throw new Error("Select at least one work item state to index.");

  const workItems = await input.adapter.fetchWorkItems({
    projectId: scope.azureProjectId,
    workItemTypes: input.workItemTypes,
    states: input.states,
  });

  const now = nowIso();
  const indexRunId = createId("ctxrun");
  const mode = input.mode ?? "incremental";
  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let inactiveCount = 0;
  let indexedWorkItemCount = 0;
  let indexedChunkCount = 0;
  let skippedEmptyCount = 0;
  const fetchedIds = new Set(workItems.map((item) => item.id));
  const existingRows = await sqlAll<{ azure_work_item_id: string; content_hash: string | null; sync_status: string | null }>(
    `
      SELECT azure_work_item_id, content_hash, sync_status
      FROM azure_devops_work_items
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    },
  );
  const existingById = new Map(existingRows.map((row) => [row.azure_work_item_id, row]));

  await withTransaction(async (client) => {
    if (mode === "rebuild") {
      await sqlRun(DELETE_PROJECT_CHUNKS_SQL, {
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
      }, client);
      await sqlRun(DELETE_PROJECT_WORK_ITEMS_SQL, {
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
      }, client);
      existingById.clear();
    }

    for (const item of workItems) {
      const text = workItemToContextText(item);
      const contentHash = stableHash(text);
      const existing = existingById.get(item.id);

      if (mode === "incremental" && existing?.content_hash === contentHash && existing.sync_status !== "inactive") {
        unchangedCount += 1;
        await sqlRun(MARK_UNCHANGED_WORK_ITEM_SQL, {
          projectId: scope.projectId,
          azureProjectId: scope.azureProjectId,
          azureWorkItemId: item.id,
          currentIndexRunId: indexRunId,
          lastSyncedAt: now,
          updatedAt: now,
        }, client);
        continue;
      }

      await sqlRun(UPSERT_WORK_ITEM_SQL, {
        id: createId("awi"),
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        azureProjectName: scope.azureProjectName,
        azureOrganizationUrl: scope.azureOrganizationUrl,
        azureWorkItemId: item.id,
        workItemType: item.workItemType,
        title: item.title,
        description: item.description ?? null,
        acceptanceCriteria: item.acceptanceCriteria ?? null,
        state: item.state ?? null,
        assignedTo: item.assignedTo ?? null,
        priority: item.priority ?? null,
        tags: item.tags?.join("; ") ?? null,
        areaPath: item.areaPath ?? null,
        iterationPath: item.iterationPath ?? null,
        rawJson: item.raw ? JSON.stringify(item.raw) : null,
        createdDate: item.createdDate ?? null,
        updatedDate: item.updatedDate ?? null,
        lastSyncedAt: now,
        contentHash,
        currentIndexRunId: indexRunId,
        createdAt: now,
        updatedAt: now,
      }, client);

      await sqlRun(DELETE_WORK_ITEM_CHUNKS_SQL, {
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        azureWorkItemId: item.id,
      }, client);
      if (existing) {
        updatedCount += 1;
      } else {
        createdCount += 1;
      }

      if (!text.trim()) {
        skippedEmptyCount += 1;
        continue;
      }

      const chunks = chunkText({
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        sourceId: item.id,
        sourceType: "azure_work_item",
        title: item.title,
        text,
      });

      for (const [index, chunk] of chunks.entries()) {
        await sqlRun(INSERT_CHUNK_SQL, {
          id: `azure_work_item_${scope.projectId}_${item.id}_${index}`,
          projectId: scope.projectId,
          azureProjectId: scope.azureProjectId,
          azureProjectName: scope.azureProjectName,
          azureWorkItemId: item.id,
          workItemType: item.workItemType,
          documentName: item.title,
          chunkIndex: index,
          content: chunk.content,
          metadataJson: JSON.stringify({
            sourceType: "azure_work_item",
            azureWorkItemId: item.id,
            workItemType: item.workItemType,
            state: item.state,
            title: item.title,
            areaPath: item.areaPath,
            iterationPath: item.iterationPath,
            tags: item.tags ?? [],
            updatedDate: item.updatedDate,
            chunkIndex: index,
          }),
          createdAt: now,
          updatedAt: now,
        }, client);
      }

      indexedWorkItemCount += 1;
      indexedChunkCount += chunks.length;
    }

    if (mode === "incremental") {
      for (const row of existingRows) {
        if (fetchedIds.has(row.azure_work_item_id)) continue;
        inactiveCount += await sqlRun(MARK_INACTIVE_WORK_ITEM_SQL, {
          projectId: scope.projectId,
          azureProjectId: scope.azureProjectId,
          azureWorkItemId: row.azure_work_item_id,
          currentIndexRunId: indexRunId,
          lastSyncedAt: now,
          updatedAt: now,
        }, client);
      }
    }

    await refreshProjectContextSearchIndex({ scope }, client);
  });

  // Embedding sync is best-effort and outside the transaction: a missing or failing
  // embedding backend must never fail or roll back context indexing, it only means
  // retrieval stays lexical until the next successful sync.
  const embeddingProvider = createEmbeddingProvider();
  let embeddingSummary: { embeddedChunkCount: number; removedEmbeddingCount: number } | undefined;
  if (embeddingProvider) {
    try {
      embeddingSummary = await syncProjectChunkEmbeddings({ scope, provider: embeddingProvider });
    } catch (error) {
      console.error("Chunk embedding sync failed; retrieval continues with full-text search only.", error);
      recordProjectKnowledgeLog({
        scope,
        eventType: "context.embedding_failed",
        severity: "warning",
        title: "Chunk embedding sync failed",
        message: error instanceof Error ? error.message : "Unknown embedding error.",
        metadata: {
          provider: embeddingProvider.name,
          model: embeddingProvider.model,
        },
      });
    }
  }

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    actor: input.actor,
    action: "rag.index_azure_work_items",
    status: "Success",
    message: `Synced ${workItems.length} Azure DevOps work items into project context.`,
    details: {
      mode,
      indexRunId,
      fetchedCount: workItems.length,
      indexedWorkItemCount,
      indexedChunkCount,
      createdCount,
      updatedCount,
      unchangedCount,
      inactiveCount,
      skippedEmptyCount,
      embeddingSummary,
      workItemTypes: input.workItemTypes,
      states: input.states,
    },
  });

  recordProjectKnowledgeLog({
    scope,
    eventType: "context.synced",
    severity: inactiveCount || updatedCount || createdCount ? "info" : "info",
    title: "Project context synced",
    message: `Context sync completed in ${mode} mode with ${createdCount} created, ${updatedCount} updated, ${unchangedCount} unchanged, and ${inactiveCount} inactive work items.`,
    metadata: {
      mode,
      indexRunId,
      fetchedCount: workItems.length,
      indexedWorkItemCount,
      indexedChunkCount,
      createdCount,
      updatedCount,
      unchangedCount,
      inactiveCount,
      skippedEmptyCount,
      workItemTypes: input.workItemTypes,
      states: input.states,
    },
  });

  return {
    mode,
    fetchedCount: workItems.length,
    storedWorkItemCount: workItems.length,
    indexedWorkItemCount,
    indexedChunkCount,
    createdCount,
    updatedCount,
    unchangedCount,
    inactiveCount,
    skippedEmptyCount,
    embeddingSummary,
    workItemTypes: input.workItemTypes,
    states: input.states,
  };
}

export async function getRecentProjectContext(input: {
  scope: ProjectScope;
  page?: number;
  pageSize?: number;
  sortBy?: ProjectContextSortBy;
  sortDirection?: ProjectContextSortDirection;
  query?: string;
}) {
  const scope = assertProjectScope(input.scope);
  ensureProjectContextSyncSchema();
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));
  const sortBy = input.sortBy ?? "lastIndexedAt";
  const sortDirection = input.sortDirection ?? "desc";
  const orderBy = contextSortSql(sortBy, sortDirection);
  const query = input.query?.trim() ?? "";
  const searchWhere = query
    ? `
        AND (
          wi.azure_work_item_id LIKE @queryLike ESCAPE '\\'
          OR wi.title LIKE @queryLike ESCAPE '\\'
          OR EXISTS (
            SELECT 1
            FROM document_chunks dc_search
            WHERE dc_search.project_id = wi.project_id
              AND dc_search.azure_project_id = wi.azure_project_id
              AND dc_search.azure_work_item_id = wi.azure_work_item_id
              AND dc_search.source_type = 'azure_work_item'
              AND dc_search.content LIKE @queryLike ESCAPE '\\'
          )
        )
      `
    : "";
  const queryParams = query ? { queryLike: `%${escapeSqlLike(query)}%` } : {};
  const total = await sqlAll<{ total: number }>(
    `
      SELECT COUNT(*)::int AS total
      FROM azure_devops_work_items wi
      WHERE wi.project_id = @projectId
        AND wi.azure_project_id = @azureProjectId
        AND COALESCE(wi.sync_status, 'active') = 'active'
        ${searchWhere}
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      ...queryParams,
    },
  );
  const totalCount = total[0]?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = await sqlAll<RecentContextRow>(
    `
      SELECT
        wi.azure_work_item_id,
        wi.work_item_type,
        wi.title,
        wi.state,
        COALESCE(wi.sync_status, 'active') AS sync_status,
        wi.updated_date,
        wi.last_synced_at,
        COUNT(dc.id)::int AS chunk_count
      FROM azure_devops_work_items wi
      LEFT JOIN document_chunks dc
        ON dc.project_id = wi.project_id
       AND dc.azure_project_id = wi.azure_project_id
       AND dc.azure_work_item_id = wi.azure_work_item_id
       AND dc.source_type = 'azure_work_item'
      WHERE wi.project_id = @projectId
        AND wi.azure_project_id = @azureProjectId
        AND COALESCE(wi.sync_status, 'active') = 'active'
        ${searchWhere}
      GROUP BY wi.azure_work_item_id, wi.work_item_type, wi.title, wi.state,
               wi.sync_status, wi.updated_date, wi.last_synced_at
      ORDER BY ${orderBy}
      LIMIT @limit OFFSET @offset
    `,
    {
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      limit: pageSize,
      offset: (safePage - 1) * pageSize,
      ...queryParams,
    },
  );

  return {
    items: rows.map((row) => ({
      workItemId: row.azure_work_item_id,
      workItemType: row.work_item_type,
      title: row.title,
      state: row.state,
      syncStatus: row.sync_status ?? "active",
      updatedDate: row.updated_date,
      lastIndexedAt: row.last_synced_at,
      chunkCount: row.chunk_count,
    })),
    totalCount,
    page: safePage,
    pageSize,
    totalPages,
    sortBy,
    sortDirection,
    query,
  };
}

export async function retrieveStoredProjectContext(input: {
  scope: ProjectScope;
  query: string;
  topK?: number;
  workItemIds?: string[];
  maxChunksPerWorkItem?: number;
  /**
   * Semantic-retrieval override, mainly for tests: undefined resolves the
   * deployment-configured backend (EMBEDDINGS_PROVIDER env), null disables
   * semantic retrieval for this call.
   */
  embeddingProvider?: EmbeddingProvider | null;
}): Promise<LlmContextSource[]> {
  const scope = assertProjectScope(input.scope);
  ensureProjectContextSyncSchema();
  const topK = input.topK ?? 8;

  if (input.workItemIds?.length) {
    // Explicit selection is a targeted fetch, not a relevance search: the caller
    // asked for these work items, so every chunk is returned in document order with
    // full relevance.
    const rows = await sqlAll<ContextChunkRow>(
      `
        SELECT id, azure_work_item_id, work_item_type, document_name, content, metadata_json
        FROM document_chunks
        WHERE project_id = @projectId
          AND azure_project_id = @azureProjectId
          AND source_type = 'azure_work_item'
          AND azure_work_item_id IN (${input.workItemIds.map((_, index) => `@id${index}`).join(", ")})
          AND EXISTS (
            SELECT 1
            FROM azure_devops_work_items wi
            WHERE wi.project_id = document_chunks.project_id
              AND wi.azure_project_id = document_chunks.azure_project_id
              AND wi.azure_work_item_id = document_chunks.azure_work_item_id
              AND COALESCE(wi.sync_status, 'active') = 'active'
          )
        ORDER BY azure_work_item_id, chunk_index
        LIMIT @limit
      `,
      {
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        limit: Math.max(topK, input.workItemIds.length * 3),
        ...Object.fromEntries(input.workItemIds.map((id, index) => [`id${index}`, id])),
      },
    );
    return rows.map((row) => toLlmContextSource(row, 1));
  }

  const ftsQuery = buildFtsQuery(input.query);
  if (!ftsQuery) return [];
  await ensureProjectContextSearchIndex({ scope });

  // Rank with Postgres FTS instead of scoring every chunk in application code. The
  // per-work-item ROW_NUMBER cap keeps one verbose work item from consuming the whole
  // topK budget: callers dedupe to distinct work items, so by default only each work
  // item's best chunk competes for a slot.
  const maxChunksPerWorkItem = Math.max(1, Math.trunc(input.maxChunksPerWorkItem ?? 1));
  const ftsRows = await sqlAll<ContextChunkRow & { rank: number }>(
    `
      WITH ranked AS (
        SELECT chunk_id, azure_work_item_id, work_item_type, title, content, metadata_json,
               ts_rank_cd(tsv, to_tsquery('simple', @ftsQuery)) AS rank,
               ROW_NUMBER() OVER (
                 PARTITION BY azure_work_item_id
                 ORDER BY ts_rank_cd(tsv, to_tsquery('simple', @ftsQuery)) DESC, chunk_id ASC
               ) AS work_item_rank
        FROM document_chunks_fts
        WHERE tsv @@ to_tsquery('simple', @ftsQuery)
          AND project_id = @projectId
          AND azure_project_id = @azureProjectId
      )
      SELECT chunk_id AS id, azure_work_item_id, work_item_type, title AS document_name,
             content, metadata_json, rank
      FROM ranked
      WHERE work_item_rank <= @maxChunksPerWorkItem
      ORDER BY rank DESC, azure_work_item_id ASC, chunk_id ASC
      LIMIT @limit
    `,
    {
      ftsQuery,
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      maxChunksPerWorkItem,
      limit: topK,
    },
  );

  // Hybrid retrieval: when an embedding backend is configured (EMBEDDINGS_PROVIDER),
  // fuse the lexical list with cosine-ranked semantic hits via reciprocal rank
  // fusion. Any semantic failure degrades to the full-text list — retrieval must
  // never hard-fail because an embedding backend is down.
  const embeddingProvider =
    input.embeddingProvider !== undefined ? input.embeddingProvider : createEmbeddingProvider();
  if (!embeddingProvider) return toRankedContextSources(ftsRows);

  let semanticRows: ContextChunkRow[] = [];
  try {
    semanticRows = await searchProjectContextByEmbedding({
      scope,
      provider: embeddingProvider,
      query: input.query,
      topK,
      maxChunksPerWorkItem,
    });
  } catch (error) {
    console.error("Semantic retrieval failed; continuing with full-text results only.", error);
  }
  if (!semanticRows.length) return toRankedContextSources(ftsRows);

  const fused = fuseByReciprocalRank<ContextChunkRow>({
    lists: [ftsRows, semanticRows],
    getKey: (row) => row.id,
  });
  const countsByWorkItem = new Map<string, number>();
  const selected: Array<{ row: ContextChunkRow; score: number }> = [];
  for (const { item, score } of fused) {
    if (selected.length >= topK) break;
    const key = item.azure_work_item_id ?? "__missing_work_item_id__";
    const count = countsByWorkItem.get(key) ?? 0;
    if (count >= maxChunksPerWorkItem) continue;
    countsByWorkItem.set(key, count + 1);
    selected.push({ row: item, score });
  }
  const maxFusedScore = selected[0]?.score ?? 0;
  return selected.map(({ row, score }) => toLlmContextSource(row, normalizeRank(score, maxFusedScore)));
}

function toRankedContextSources(rows: Array<ContextChunkRow & { rank: number }>) {
  const maxRank = rows[0]?.rank ?? 0;
  return rows.map((row) => toLlmContextSource(row, normalizeRank(row.rank, maxRank)));
}

// LlmContextSource.relevanceScore stays 0..1 (prompt renderers and the LLM context
// selection contract present it that way), so raw ranking values (ts_rank_cd or RRF
// scores) are normalized against the best match in the result set.
function normalizeRank(rank: number, maxRank: number) {
  if (!(maxRank > 0)) return 1;
  return Math.max(0.01, Math.round((rank / maxRank) * 100) / 100);
}

export function workItemToContextText(item: Requirement) {
  return [
    `Work item ID: ${item.id}`,
    `Type: ${item.workItemType}`,
    `State: ${item.state ?? "Unknown"}`,
    `Title: ${item.title}`,
    item.description ? `Description:\n${stripHtml(item.description)}` : "",
    item.acceptanceCriteria ? `Acceptance criteria:\n${stripHtml(item.acceptanceCriteria)}` : "",
    item.tags?.length ? `Tags: ${item.tags.join(", ")}` : "",
    item.areaPath ? `Area path: ${item.areaPath}` : "",
    item.iterationPath ? `Iteration path: ${item.iterationPath}` : "",
    item.updatedDate ? `Updated: ${item.updatedDate}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function workItemToLlmContextSource(item: Requirement, relevanceScore = 1): LlmContextSource {
  return {
    sourceType: "azure_work_item",
    workItemId: item.id,
    workItemType: item.workItemType,
    state: item.state ?? "Unknown",
    title: item.title,
    content: workItemToContextText(item),
    relevanceScore,
    metadata: {
      areaPath: item.areaPath,
      iterationPath: item.iterationPath,
      tags: item.tags,
      updatedDate: item.updatedDate,
      chunkIndex: 0,
    },
  };
}

export function requirementToRetrievalQuery(item: Requirement) {
  return [
    item.title,
    item.description ? stripHtml(item.description) : "",
    item.acceptanceCriteria ? stripHtml(item.acceptanceCriteria) : "",
    item.tags?.join(" ") ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function toLlmContextSource(row: ContextChunkRow, score: number): LlmContextSource {
  const metadata = parseMetadata(row.metadata_json);
  return {
    sourceType: "azure_work_item",
    workItemId: metadata.azureWorkItemId ?? row.azure_work_item_id ?? "",
    workItemType: metadata.workItemType ?? row.work_item_type ?? "Unknown",
    state: metadata.state ?? "Unknown",
    title: metadata.title ?? row.document_name ?? "Untitled work item",
    content: row.content,
    relevanceScore: score,
    metadata: {
      areaPath: metadata.areaPath,
      iterationPath: metadata.iterationPath,
      tags: metadata.tags,
      updatedDate: metadata.updatedDate,
      chunkIndex: metadata.chunkIndex ?? 0,
    },
  };
}

function parseMetadata(value: string | null): {
  azureWorkItemId?: string;
  workItemType?: string;
  state?: string;
  title?: string;
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
  updatedDate?: string;
  chunkIndex?: number;
} {
  if (!value) return {};
  try {
    return JSON.parse(value) as ReturnType<typeof parseMetadata>;
  } catch {
    return {};
  }
}

function stableHash(value: string) {
  return getCrypto().createHash("sha256").update(value).digest("hex");
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function getCrypto() {
  return nativeRequire("crypto") as CryptoModule;
}

function nativeRequire(specifier: string): unknown {
  const requireFunction = eval("require") as NodeRequire;
  return requireFunction(specifier);
}

function contextSortSql(sortBy: ProjectContextSortBy, direction: ProjectContextSortDirection) {
  const directionSql = direction === "asc" ? "ASC" : "DESC";
  if (sortBy === "type") return `wi.work_item_type ${directionSql}, wi.last_synced_at DESC, wi.updated_date DESC`;
  if (sortBy === "state") return `COALESCE(wi.state, '') ${directionSql}, wi.last_synced_at DESC, wi.updated_date DESC`;
  return `wi.last_synced_at ${directionSql}, wi.updated_date ${directionSql}`;
}

function escapeSqlLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
