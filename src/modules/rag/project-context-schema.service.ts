import "server-only";

/**
 * The project-context columns are part of the initial PostgreSQL migration. This
 * is a no-op retained for call-site compatibility.
 */
export function ensureProjectContextSyncSchema() {
  // No-op: schema is owned by migrations.
}
