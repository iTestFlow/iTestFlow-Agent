/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE jobs
      ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE,
      ADD COLUMN IF NOT EXISTS progress_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS result_json jsonb,
      ADD COLUMN IF NOT EXISTS cancel_requested_at text;

    CREATE INDEX IF NOT EXISTS idx_jobs_project
      ON jobs (workspace_id, project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_knowledge_job_batches (
      id text PRIMARY KEY,
      job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      batch_key text NOT NULL,
      status text NOT NULL CHECK (status IN ('running', 'completed')),
      result_json jsonb,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (job_id, batch_key)
    );

    CREATE INDEX IF NOT EXISTS idx_project_knowledge_job_batches
      ON project_knowledge_job_batches (job_id, status, updated_at);

    UPDATE project_knowledge_drafts
    SET status = 'superseded',
        status_reason = 'v4_upgrade_requires_new_build',
        pending_drift = false,
        updated_at = COALESCE(updated_at, created_at)
    WHERE compiler_contract_version IS DISTINCT FROM '4.0.0'
      AND status IN ('generating', 'awaiting_input', 'ready_for_review', 'blocked', 'rebase_required');

    UPDATE project_knowledge_base
    SET compiler_compatibility = 'upgrade_required'
    WHERE compiler_contract_version IS DISTINCT FROM '4.0.0';

    DROP INDEX IF EXISTS idx_knowledge_drafts_one_live_child;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS project_knowledge_job_batches;
    DROP INDEX IF EXISTS idx_jobs_project;
    ALTER TABLE jobs
      DROP COLUMN IF EXISTS cancel_requested_at,
      DROP COLUMN IF EXISTS result_json,
      DROP COLUMN IF EXISTS progress_json,
      DROP COLUMN IF EXISTS project_id;
  `);
};
