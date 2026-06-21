/* eslint-disable camelcase */

/**
 * Phase 4 — background job queue.
 *
 * A PostgreSQL-backed job table claimed with SELECT ... FOR UPDATE SKIP LOCKED so
 * multiple workers never process the same job. Jobs are workspace-scoped; the
 * worker runs them without any logged-in user (scheduled sync uses the workspace
 * sync credential, not a user PAT). run_after enables retry backoff and future
 * scheduling. Timestamps are ISO-8601 text, consistent with the rest of the schema.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE jobs (
      id text PRIMARY KEY,
      workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
      job_type text NOT NULL,
      payload_json text NOT NULL DEFAULT '{}',
      dedupe_key text,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
      priority integer NOT NULL DEFAULT 100,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      locked_by text,
      locked_at text,
      run_after text NOT NULL,
      started_at text,
      finished_at text,
      error_message text,
      created_by_user_id text REFERENCES users(id),
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    -- Claim ordering: ready (pending + due) jobs by priority then age.
    CREATE INDEX idx_jobs_claim ON jobs (status, run_after, priority, created_at);
    CREATE INDEX idx_jobs_workspace ON jobs (workspace_id, created_at);
    -- At most one active (pending/running) job per (workspace, type, dedupe key)
    -- so the auto-enqueuer can't pile up duplicate syncs for the same project.
    CREATE UNIQUE INDEX uq_jobs_active_dedupe
      ON jobs (workspace_id, job_type, dedupe_key)
      WHERE status IN ('pending', 'running');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS jobs CASCADE;`);
};
