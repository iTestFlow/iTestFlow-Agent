import "server-only";

import { getDatabase } from "@/modules/shared/infrastructure/database/db";

let ensured = false;

export function ensureProjectContextSyncSchema() {
  if (ensured) return;

  const db = getDatabase();
  const columns = new Set(
    (db.prepare("PRAGMA table_info(azure_devops_work_items)").all() as Array<{ name: string }>).map((column) => column.name),
  );

  if (!columns.has("content_hash")) {
    db.exec("ALTER TABLE azure_devops_work_items ADD COLUMN content_hash TEXT");
  }
  if (!columns.has("sync_status")) {
    db.exec("ALTER TABLE azure_devops_work_items ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!columns.has("current_index_run_id")) {
    db.exec("ALTER TABLE azure_devops_work_items ADD COLUMN current_index_run_id TEXT");
  }

  ensured = true;
}
