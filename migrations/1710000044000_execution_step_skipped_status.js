/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE playwright_execution_steps
      DROP CONSTRAINT playwright_execution_steps_status_check,
      ADD CONSTRAINT playwright_execution_steps_status_check
        CHECK (status IN ('queued', 'running', 'passed', 'failed', 'blocked', 'timeout', 'cancelled', 'error', 'skipped'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE playwright_execution_steps SET status = 'cancelled' WHERE status = 'skipped';

    ALTER TABLE playwright_execution_steps
      DROP CONSTRAINT playwright_execution_steps_status_check,
      ADD CONSTRAINT playwright_execution_steps_status_check
        CHECK (status IN ('queued', 'running', 'passed', 'failed', 'blocked', 'timeout', 'cancelled', 'error'));
  `);
};
