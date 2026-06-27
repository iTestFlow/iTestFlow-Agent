/* eslint-disable camelcase */

/**
 * Per-workspace overrides for workflow value-metrics baselines, edited in the
 * Settings → Value Metrics tab. Both columns hold a partial JSON map of
 * WorkflowType → minutes; a missing key (or a NULL column) inherits the
 * deployment default (defaultWorkflowBaselines / defaultReviewBaselines).
 *
 *  - manual_baseline_minutes: estimated fully-manual human effort (M).
 *  - review_baseline_minutes: estimated human review effort of the AI output (R);
 *    interpreted as minutes/item for generative workflows (PUBLISH_WORKFLOW_TYPES)
 *    and minutes/run for conversational ones.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      ADD COLUMN IF NOT EXISTS manual_baseline_minutes jsonb,
      ADD COLUMN IF NOT EXISTS review_baseline_minutes jsonb;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      DROP COLUMN IF EXISTS manual_baseline_minutes,
      DROP COLUMN IF EXISTS review_baseline_minutes;
  `);
};
