/* eslint-disable camelcase */

/**
 * Remove legacy single-user analytics defaults.
 *
 * Multi-user routes must provide the authenticated user id explicitly. Keeping a
 * database default can hide missed call sites as "local-user" rows.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE analytics_workflow_runs ALTER COLUMN user_id DROP DEFAULT;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE analytics_workflow_runs ALTER COLUMN user_id SET DEFAULT 'local-user';`);
};
