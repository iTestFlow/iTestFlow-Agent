import "server-only";

import { createId, getDatabase, nowIso } from "@/modules/shared/infrastructure/database/db";
import { assertProjectScope, type ProjectScope } from "@/modules/projects/project-isolation.guard";
import { writeAuditLog } from "@/modules/audit/audit.service";
import type { AzureDevOpsAdapter } from "@/modules/integrations/azure-devops/azure-devops-adapter";
import type { Requirement } from "@/modules/integrations/azure-devops/azure-devops-types";
import { chunkText } from "./rag-pipeline.service";
import { refreshProjectContextSearchIndex } from "./context-chatbot-retrieval.service";

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
  updated_date: string | null;
  last_synced_at: string | null;
  chunk_count: number;
};

export type ProjectContextSortBy = "lastIndexedAt" | "type" | "state";
export type ProjectContextSortDirection = "asc" | "desc";

export async function indexAzureWorkItemsAsProjectContext(input: {
  scope: ProjectScope;
  adapter: AzureDevOpsAdapter;
  workItemTypes: string[];
  states: string[];
}) {
  const scope = assertProjectScope(input.scope);
  if (!input.workItemTypes.length) throw new Error("Select at least one work item type to index.");
  if (!input.states.length) throw new Error("Select at least one work item state to index.");

  const workItems = await input.adapter.fetchWorkItems({
    projectId: scope.azureProjectId,
    workItemTypes: input.workItemTypes,
    states: input.states,
  });

  const db = getDatabase();
  const now = nowIso();
  let indexedWorkItemCount = 0;
  let indexedChunkCount = 0;
  let skippedEmptyCount = 0;

  const upsertWorkItem = db.prepare(`
    INSERT INTO azure_devops_work_items (
      id, project_id, azure_project_id, azure_project_name, azure_organization_url,
      azure_work_item_id, work_item_type, title, description, acceptance_criteria,
      state, assigned_to, priority, tags, area_path, iteration_path, raw_json,
      created_date, updated_date, last_synced_at, created_at, updated_at
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, @azureOrganizationUrl,
      @azureWorkItemId, @workItemType, @title, @description, @acceptanceCriteria,
      @state, @assignedTo, @priority, @tags, @areaPath, @iterationPath, @rawJson,
      @createdDate, @updatedDate, @lastSyncedAt, @createdAt, @updatedAt
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
      updated_at = excluded.updated_at
  `);
  const deleteChunks = db.prepare(`
    DELETE FROM document_chunks
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
      AND source_type = 'azure_work_item'
      AND azure_work_item_id = @azureWorkItemId
  `);
  const deleteProjectChunks = db.prepare(`
    DELETE FROM document_chunks
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
      AND source_type = 'azure_work_item'
  `);
  const deleteProjectWorkItems = db.prepare(`
    DELETE FROM azure_devops_work_items
    WHERE project_id = @projectId
      AND azure_project_id = @azureProjectId
  `);
  const insertChunk = db.prepare(`
    INSERT INTO document_chunks (
      id, project_id, azure_project_id, azure_project_name, source_type,
      azure_work_item_id, work_item_type, document_name, document_type,
      chunk_index, content, metadata_json, created_at, updated_at
    ) VALUES (
      @id, @projectId, @azureProjectId, @azureProjectName, 'azure_work_item',
      @azureWorkItemId, @workItemType, @documentName, 'azure_work_item',
      @chunkIndex, @content, @metadataJson, @createdAt, @updatedAt
    )
  `);

  try {
    db.exec("BEGIN");
    deleteProjectChunks.run({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    });
    deleteProjectWorkItems.run({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    });

    for (const item of workItems) {
      upsertWorkItem.run({
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
        createdAt: now,
        updatedAt: now,
      });

      deleteChunks.run({
        projectId: scope.projectId,
        azureProjectId: scope.azureProjectId,
        azureWorkItemId: item.id,
      });

      const text = workItemToContextText(item);
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

      chunks.forEach((chunk, index) => {
        insertChunk.run({
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
        });
      });

      indexedWorkItemCount += 1;
      indexedChunkCount += chunks.length;
    }

    refreshProjectContextSearchIndex({ scope });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  writeAuditLog({
    projectId: scope.projectId,
    azureProjectId: scope.azureProjectId,
    azureProjectName: scope.azureProjectName,
    azureOrganizationUrl: scope.azureOrganizationUrl,
    action: "rag.index_azure_work_items",
    status: "Success",
    message: `Indexed ${indexedWorkItemCount} Azure DevOps work items into project context.`,
    details: {
      fetchedCount: workItems.length,
      indexedWorkItemCount,
      indexedChunkCount,
      skippedEmptyCount,
      workItemTypes: input.workItemTypes,
      states: input.states,
    },
  });

  return {
    fetchedCount: workItems.length,
    storedWorkItemCount: workItems.length,
    indexedWorkItemCount,
    indexedChunkCount,
    skippedEmptyCount,
    workItemTypes: input.workItemTypes,
    states: input.states,
  };
}

export function getRecentProjectContext(input: {
  scope: ProjectScope;
  page?: number;
  pageSize?: number;
  sortBy?: ProjectContextSortBy;
  sortDirection?: ProjectContextSortDirection;
}) {
  const scope = assertProjectScope(input.scope);
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 25));
  const sortBy = input.sortBy ?? "lastIndexedAt";
  const sortDirection = input.sortDirection ?? "desc";
  const orderBy = contextSortSql(sortBy, sortDirection);
  const db = getDatabase();
  const total = db
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM azure_devops_work_items
      WHERE project_id = @projectId
        AND azure_project_id = @azureProjectId
    `,
    )
    .get({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
    }) as { total: number };
  const totalCount = total.total;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(page, totalPages);
  const rows = db
    .prepare(
      `
      SELECT
        wi.azure_work_item_id,
        wi.work_item_type,
        wi.title,
        wi.state,
        wi.updated_date,
        wi.last_synced_at,
        COUNT(dc.id) AS chunk_count
      FROM azure_devops_work_items wi
      LEFT JOIN document_chunks dc
        ON dc.project_id = wi.project_id
       AND dc.azure_project_id = wi.azure_project_id
       AND dc.azure_work_item_id = wi.azure_work_item_id
       AND dc.source_type = 'azure_work_item'
      WHERE wi.project_id = @projectId
        AND wi.azure_project_id = @azureProjectId
      GROUP BY wi.azure_work_item_id
      ORDER BY ${orderBy}
      LIMIT @limit OFFSET @offset
    `,
    )
    .all({
      projectId: scope.projectId,
      azureProjectId: scope.azureProjectId,
      limit: pageSize,
      offset: (safePage - 1) * pageSize,
    }) as RecentContextRow[];

  return {
    items: rows.map((row) => ({
      workItemId: row.azure_work_item_id,
      workItemType: row.work_item_type,
      title: row.title,
      state: row.state,
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
  };
}

export function retrieveStoredProjectContext(input: {
  scope: ProjectScope;
  query: string;
  topK?: number;
  workItemIds?: string[];
}): LlmContextSource[] {
  const scope = assertProjectScope(input.scope);
  const db = getDatabase();
  const topK = input.topK ?? 8;

  const rows = input.workItemIds?.length
    ? db
        .prepare(
          `
          SELECT id, azure_work_item_id, work_item_type, document_name, content, metadata_json
          FROM document_chunks
          WHERE project_id = @projectId
            AND azure_project_id = @azureProjectId
            AND source_type = 'azure_work_item'
            AND azure_work_item_id IN (${input.workItemIds.map((_, index) => `@id${index}`).join(", ")})
          ORDER BY azure_work_item_id, chunk_index
          LIMIT @limit
        `,
        )
        .all({
          projectId: scope.projectId,
          azureProjectId: scope.azureProjectId,
          limit: Math.max(topK, input.workItemIds.length * 3),
          ...Object.fromEntries(input.workItemIds.map((id, index) => [`id${index}`, id])),
        })
    : db
        .prepare(
          `
          SELECT id, azure_work_item_id, work_item_type, document_name, content, metadata_json
          FROM document_chunks
          WHERE project_id = @projectId
            AND azure_project_id = @azureProjectId
            AND source_type = 'azure_work_item'
        `,
        )
        .all({
          projectId: scope.projectId,
          azureProjectId: scope.azureProjectId,
        });

  const terms = tokenize(input.query);
  return (rows as ContextChunkRow[])
    .map((row) => toLlmContextSource(row, scoreContent(row.content, terms)))
    .filter((source) => input.workItemIds?.length || source.relevanceScore > 0)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, topK);
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

function tokenize(value: string) {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
}

function scoreContent(content: string, terms: string[]) {
  if (!terms.length) return 0;
  const haystack = content.toLowerCase();
  const hits = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0);
  return Math.round((hits / terms.length) * 100) / 100;
}

function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function contextSortSql(sortBy: ProjectContextSortBy, direction: ProjectContextSortDirection) {
  const directionSql = direction === "asc" ? "ASC" : "DESC";
  if (sortBy === "type") return `wi.work_item_type ${directionSql}, wi.last_synced_at DESC, wi.updated_date DESC`;
  if (sortBy === "state") return `COALESCE(wi.state, '') ${directionSql}, wi.last_synced_at DESC, wi.updated_date DESC`;
  return `wi.last_synced_at ${directionSql}, wi.updated_date ${directionSql}`;
}
