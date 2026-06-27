/* eslint-disable camelcase */

/**
 * Snapshots the human-effort breakdown of each workflow run so the system
 * dashboard can report two distinct, auditable savings metrics:
 *
 *   review_minutes      - estimated human review effort of the AI output (R)
 *   generation_minutes  - LLM/machine generation time (elapsed)             (LLM)
 *   cycle_saved_minutes - cycle-time saved = max(M - (LLM + R), 0)
 *
 * The existing manual_baseline_minutes (M) and estimated_saved_minutes columns
 * remain; estimated_saved_minutes now stores LABOR saved = max(M - R, 0).
 * All values are snapshotted at completion; historical rows are left as-is
 * (no backfill) — the new columns are NULL for runs completed before this change.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE analytics_workflow_runs
      ADD COLUMN IF NOT EXISTS review_minutes double precision,
      ADD COLUMN IF NOT EXISTS generation_minutes double precision,
      ADD COLUMN IF NOT EXISTS cycle_saved_minutes double precision;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE analytics_workflow_runs
      DROP COLUMN IF EXISTS review_minutes,
      DROP COLUMN IF EXISTS generation_minutes,
      DROP COLUMN IF EXISTS cycle_saved_minutes;
  `);
};
