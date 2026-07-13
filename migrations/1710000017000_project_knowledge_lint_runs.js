exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE project_knowledge_lint_issues
      ADD COLUMN IF NOT EXISTS lint_run_id text;

    CREATE TABLE IF NOT EXISTS project_knowledge_lint_runs (
      id text PRIMARY KEY,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      issue_count integer NOT NULL DEFAULT 0,
      error_count integer NOT NULL DEFAULT 0,
      warning_count integer NOT NULL DEFAULT 0,
      started_at text NOT NULL,
      completed_at text NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_knowledge_lint_runs_project
      ON project_knowledge_lint_runs(project_id, azure_project_id, completed_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_project_knowledge_lint_runs_project;
    DROP TABLE IF EXISTS project_knowledge_lint_runs;
    ALTER TABLE project_knowledge_lint_issues DROP COLUMN IF EXISTS lint_run_id;
  `);
};
