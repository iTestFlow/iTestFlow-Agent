import "server-only";

/**
 * Historically this lazily added columns to azure_devops_work_items on first use
 * (content_hash, sync_status, current_index_run_id) for older node:sqlite
 * databases. Those columns are now part of the initial PostgreSQL migration, so
 * this is a no-op retained for call-site compatibility.
 */
export function ensureProjectContextSyncSchema() {
  // No-op: schema is owned by migrations.
}
