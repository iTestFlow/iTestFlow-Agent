/* eslint-disable camelcase */

/**
 * Follow-up (c) — per-workspace cron sync schedules.
 *
 * One optional schedule per workspace. The worker evaluates enabled schedules and
 * enqueues that workspace's context sync when due (using the workspace sync
 * credential, no user). cron_expression is a 5-field cron evaluated in the
 * worker's local timezone; next_run_at is the absolute UTC ISO instant of the
 * next fire, advanced atomically when the schedule is claimed so concurrent
 * workers don't double-fire. Timestamps are ISO-8601 text, like the rest of the
 * schema; enabled is an integer flag (0/1), matching user_llm_settings.is_default.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE workspace_sync_schedules (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      cron_expression text NOT NULL,
      enabled integer NOT NULL DEFAULT 1,
      next_run_at text,
      last_enqueued_at text,
      created_by_user_id text REFERENCES users(id),
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (workspace_id)
    );

    -- The worker selects due schedules by (enabled, next_run_at <= now).
    CREATE INDEX idx_sync_schedules_due ON workspace_sync_schedules (enabled, next_run_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS workspace_sync_schedules CASCADE;`);
};
