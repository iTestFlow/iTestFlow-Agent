/* eslint-disable camelcase */

/**
 * Workspace project anchor hardening.
 *
 * Canonicalizes Azure-backed projects so projects.id equals the Azure project
 * GUID, then backfills workspace_id for shared feature rows. This lets runtime
 * feature code resolve project ownership by (project_id, workspace_id) instead
 * of trusting client-supplied Azure project/org data.
 */

exports.shorthands = undefined;

const FEATURE_TABLES = [
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
  pgm.sql(`
    ALTER TABLE selected_azure_project DROP CONSTRAINT IF EXISTS selected_azure_project_project_id_fkey;
    ALTER TABLE project_settings DROP CONSTRAINT IF EXISTS project_settings_project_id_fkey;
  `);

  for (const table of FEATURE_TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = 'project_id'
        ) AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = 'azure_project_id'
        ) THEN
          EXECUTE 'UPDATE ${table}
                   SET project_id = azure_project_id
                   WHERE azure_project_id IS NOT NULL
                     AND project_id IS DISTINCT FROM azure_project_id';
        END IF;
      END $$;
    `);
  }

  pgm.sql(`
    UPDATE projects
       SET id = azure_project_id,
           updated_at = COALESCE(updated_at, created_at)
     WHERE azure_project_id IS NOT NULL
       AND id IS DISTINCT FROM azure_project_id
       AND NOT EXISTS (
         SELECT 1 FROM projects existing WHERE existing.id = projects.azure_project_id
       );
  `);

  pgm.sql(`
    DO $$
    DECLARE
      table_record record;
      name_expression text;
    BEGIN
      FOR table_record IN
        SELECT c.table_name
          FROM information_schema.columns c
         WHERE c.table_schema = 'public'
           AND c.column_name = 'azure_organization_url'
           AND EXISTS (
             SELECT 1 FROM information_schema.columns p
              WHERE p.table_schema = c.table_schema
                AND p.table_name = c.table_name
                AND p.column_name = 'azure_project_id'
           )
      LOOP
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM information_schema.columns n
           WHERE n.table_schema = 'public'
             AND n.table_name = table_record.table_name
             AND n.column_name = 'azure_project_name'
        )
          THEN 'COALESCE(NULLIF(azure_project_name, ''''), azure_project_id)'
          ELSE 'azure_project_id'
        END
        INTO name_expression;

        EXECUTE format(
          'INSERT INTO projects (
             id, azure_project_id, azure_project_name, azure_organization_url,
             name, status, workspace_id, created_at, updated_at
           )
           SELECT DISTINCT
             t.azure_project_id,
             t.azure_project_id,
             %s,
             t.azure_organization_url,
             %s,
             ''active'',
             w.id,
             NOW()::text,
             NOW()::text
           FROM %I t
           JOIN workspaces w ON w.azure_org_url = t.azure_organization_url
           WHERE t.azure_project_id IS NOT NULL
             AND t.azure_organization_url IS NOT NULL
           ON CONFLICT (azure_organization_url, azure_project_id)
           DO UPDATE SET
             id = EXCLUDED.id,
             azure_project_name = EXCLUDED.azure_project_name,
             name = EXCLUDED.name,
             status = ''active'',
             workspace_id = EXCLUDED.workspace_id,
             updated_at = EXCLUDED.updated_at',
          name_expression,
          name_expression,
          table_record.table_name
        );
      END LOOP;
    END $$;

    UPDATE projects p
       SET workspace_id = w.id,
           updated_at = NOW()::text
      FROM workspaces w
     WHERE p.workspace_id IS NULL
       AND w.azure_org_url = p.azure_organization_url;
  `);

  for (const table of FEATURE_TABLES) {
    pgm.sql(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = 'workspace_id'
        ) THEN
          EXECUTE 'UPDATE ${table} t
                      SET workspace_id = p.workspace_id
                     FROM projects p
                    WHERE t.project_id = p.id
                      AND p.workspace_id IS NOT NULL
                      AND (t.workspace_id IS NULL OR t.workspace_id <> p.workspace_id)';
        END IF;
      END $$;
    `);
  }

  pgm.sql(`
    ALTER TABLE selected_azure_project
      ADD CONSTRAINT selected_azure_project_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id);
    ALTER TABLE project_settings
      ADD CONSTRAINT project_settings_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id);
  `);
};

exports.down = (pgm) => {
  // This migration canonicalizes ids and backfills workspace ownership. Reversing
  // would require historical project ids that are no longer available.
  pgm.sql(`SELECT 1;`);
};
