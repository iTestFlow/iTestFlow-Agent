/* eslint-disable camelcase */

/**
 * Test Execution — free-text execution notes on environment profiles.
 *
 * The test author's guidance about the application under test ("dates are
 * DD/MM/YYYY", "wait for the dashboard spinner after login"). Shown to the
 * execution agent as context on every step; it never overrides the code-side
 * safety boundary (action allowlist, ref/origin/secret validation).
 * Per-test-user notes live inside users_json and need no schema change.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE test_environment_profiles
      ADD COLUMN IF NOT EXISTS execution_notes text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE test_environment_profiles
      DROP COLUMN IF EXISTS execution_notes;
  `);
};
