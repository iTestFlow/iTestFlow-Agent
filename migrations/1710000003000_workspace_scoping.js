/* eslint-disable camelcase */

/**
 * Phase 3b — workspace_id normalization.
 *
 * Adds an explicit workspace_id FK to every shared feature table so all shared
 * records are workspace-scoped (the plan's "every shared table must include
 * workspace_id"). Population is automatic and requires NO data-access changes:
 *
 *   - projects.workspace_id is derived from workspaces by azure_organization_url
 *     (org == workspace) on insert, and backfilled.
 *   - every feature table's workspace_id is derived from its project_id ->
 *     projects.workspace_id on insert, and backfilled.
 *
 * Data was already isolated by the existing project_id / azure_organization_url
 * boundary, so this is normalization (enables workspace-level admin/cleanup and
 * the Phase 4 worker's workspace-scoped jobs), not a security fix. Reads are NOT
 * re-scoped here — features keep their existing project scoping.
 */

exports.shorthands = undefined;

// Tables with a project_id column, excluding `projects` (handled separately) and
// the two derived FTS tables (rebuilt from base tables, not queried by workspace).
const TABLES = [
  "analytics_workflow_runs",
  "audit_logs",
  "azure_devops_comment_drafts",
  "azure_devops_comment_push_runs",
  "azure_devops_connections",
  "azure_devops_linked_test_cases",
  "azure_devops_projects",
  "azure_devops_sync_runs",
  "azure_devops_test_case_links",
  "azure_devops_test_case_push_runs",
  "azure_devops_test_plans",
  "azure_devops_test_suites",
  "azure_devops_work_item_links",
  "azure_devops_work_items",
  "context_auto_update_runs",
  "context_selected_items",
  "context_suggested_items",
  "context_suggestion_runs",
  "document_chunks",
  "documents",
  "embeddings",
  "existing_test_case_review_findings",
  "existing_test_case_review_runs",
  "generated_test_cases",
  "llm_providers_config",
  "llm_request_logs",
  "manual_test_cases",
  "project_knowledge_base",
  "project_knowledge_entries",
  "project_knowledge_entry_versions",
  "project_knowledge_lint_issues",
  "project_knowledge_log",
  "project_knowledge_revisions",
  "project_settings",
  "prompt_versions",
  "requirement_analysis_findings",
  "requirement_analysis_runs",
  "requirements",
  "scoring_results",
  "selected_azure_project",
  "selected_requirement_findings",
  "selected_test_cases",
  "suggested_test_case_additions",
  "test_case_edit_history",
  "test_case_generation_runs",
  "test_case_steps",
  "test_cases",
];

exports.up = (pgm) => {
  // Trigger functions.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_project_workspace_from_org() RETURNS trigger AS $$
    BEGIN
      IF NEW.workspace_id IS NULL THEN
        SELECT id INTO NEW.workspace_id FROM workspaces WHERE azure_org_url = NEW.azure_organization_url;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE OR REPLACE FUNCTION set_workspace_id_from_project() RETURNS trigger AS $$
    BEGIN
      IF NEW.workspace_id IS NULL AND NEW.project_id IS NOT NULL THEN
        SELECT workspace_id INTO NEW.workspace_id FROM projects WHERE id = NEW.project_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // projects: link to workspace by org URL, then backfill existing rows.
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_set_project_workspace ON projects;
    CREATE TRIGGER trg_set_project_workspace BEFORE INSERT ON projects
      FOR EACH ROW EXECUTE FUNCTION set_project_workspace_from_org();
    UPDATE projects p SET workspace_id = w.id
      FROM workspaces w
      WHERE p.workspace_id IS NULL AND w.azure_org_url = p.azure_organization_url;
    CREATE INDEX IF NOT EXISTS idx_projects_ws ON projects(workspace_id);
  `);

  for (const table of TABLES) {
    pgm.sql(`
      ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id);
      DROP TRIGGER IF EXISTS trg_set_workspace ON ${table};
      CREATE TRIGGER trg_set_workspace BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION set_workspace_id_from_project();
      UPDATE ${table} t SET workspace_id = p.workspace_id
        FROM projects p
        WHERE t.workspace_id IS NULL AND p.id = t.project_id;
      CREATE INDEX IF NOT EXISTS idx_${table}_ws ON ${table}(workspace_id);
    `);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS trg_set_project_workspace ON projects;`);
  pgm.sql(`DROP INDEX IF EXISTS idx_projects_ws;`);
  for (const table of TABLES) {
    pgm.sql(`
      DROP TRIGGER IF EXISTS trg_set_workspace ON ${table};
      DROP INDEX IF EXISTS idx_${table}_ws;
      ALTER TABLE ${table} DROP COLUMN IF EXISTS workspace_id;
    `);
  }
  pgm.sql(`DROP FUNCTION IF EXISTS set_workspace_id_from_project();`);
  pgm.sql(`DROP FUNCTION IF EXISTS set_project_workspace_from_org();`);
  // Note: projects.workspace_id column is owned by the Phase 1b migration; left intact.
};
