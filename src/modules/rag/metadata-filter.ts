/**
 * Optional restriction of retrieval candidates by work item metadata — type, area
 * path, iteration path. Deliberately does NOT include work item state: the user
 * already chooses which types and states to index in the Load Project Index panel,
 * and a Closed bug is among the most valuable content in this product's corpus (it
 * carries reproduction steps, expected-vs-actual, and the role that hit it). Query-time
 * state filtering would silently re-filter a choice the user deliberately made.
 *
 * Every field is opt-in. No filter applied is the default and costs nothing extra —
 * each condition below short-circuits on `IS NULL` before touching the join. These are
 * intentionally work-item-only filters: when one is supplied, uploaded-document
 * chunks (which have no work-item type/path) do not match. Callers that want only
 * documents should use the explicit source-kind filter instead.
 */
export type MetadataFilter = {
  workItemTypes?: string[];
  areaPaths?: string[];
  iterationPaths?: string[];
};

export type MetadataFilterParams = {
  workItemTypes: string[] | null;
  areaPaths: string[] | null;
  iterationPaths: string[] | null;
};

/** Normalizes a filter into the null-means-no-filter param shape the SQL fragments expect. */
export function metadataFilterParams(filter: MetadataFilter | undefined): MetadataFilterParams {
  return {
    workItemTypes: filter?.workItemTypes?.length ? filter.workItemTypes : null,
    areaPaths: filter?.areaPaths?.length ? filter.areaPaths : null,
    iterationPaths: filter?.iterationPaths?.length ? filter.iterationPaths : null,
  };
}

/**
 * SQL fragment restricting by work item type, evaluated directly against the chunk
 * table (document_chunks / document_chunks_fts both carry work_item_type as a plain
 * column, so this needs no join).
 *
 * @param columnPrefix optional table alias prefix, e.g. "dc." for an aliased join;
 *   omit for unaliased queries (document_chunks_fts referenced with bare column names).
 */
export function workItemTypeFilterSql(columnPrefix = ""): string {
  return `(@workItemTypes::text[] IS NULL OR ${columnPrefix}work_item_type = ANY(@workItemTypes))`;
}

/**
 * SQL fragment restricting by area path / iteration path. Those columns live only on
 * azure_devops_work_items, not on the chunk tables, so this joins via EXISTS — the same
 * shape ACTIVE_CHUNK_FILTER_SQL already uses in embedding-store.service.ts.
 *
 * @param refs column references for project_id / azure_project_id / azure_work_item_id
 *   on the querying table, matching that query's own aliasing convention.
 * @param joinAlias alias for the azure_devops_work_items join, must be unique within
 *   the query (multiple filter fragments in one query would otherwise collide).
 */
export function workItemPathFilterSql(
  refs: { projectId: string; azureProjectId: string; azureWorkItemId: string },
  joinAlias: string,
): string {
  return `
    (@areaPaths::text[] IS NULL OR EXISTS (
      SELECT 1 FROM azure_devops_work_items ${joinAlias}
      WHERE ${joinAlias}.project_id = ${refs.projectId}
        AND ${joinAlias}.azure_project_id = ${refs.azureProjectId}
        AND ${joinAlias}.azure_work_item_id = ${refs.azureWorkItemId}
        AND ${joinAlias}.area_path = ANY(@areaPaths)
    ))
    AND (@iterationPaths::text[] IS NULL OR EXISTS (
      SELECT 1 FROM azure_devops_work_items ${joinAlias}_it
      WHERE ${joinAlias}_it.project_id = ${refs.projectId}
        AND ${joinAlias}_it.azure_project_id = ${refs.azureProjectId}
        AND ${joinAlias}_it.azure_work_item_id = ${refs.azureWorkItemId}
        AND ${joinAlias}_it.iteration_path = ANY(@iterationPaths)
    ))
  `;
}
