/* eslint-disable camelcase */

/**
 * Store the work item type and state filters used by scheduled workspace sync.
 * The worker copies these JSON-encoded string arrays into each queued sync job.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_sync_schedules
      ADD COLUMN work_item_types text NOT NULL DEFAULT '[]',
      ADD COLUMN states text NOT NULL DEFAULT '[]';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_sync_schedules
      DROP COLUMN IF EXISTS work_item_types,
      DROP COLUMN IF EXISTS states;
  `);
};
