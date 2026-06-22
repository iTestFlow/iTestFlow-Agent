/* eslint-disable camelcase */

/**
 * Adds a configurable LLM retry-attempts column to workspace_settings.
 * NULL means "inherit the deployment default" (DEFAULT_RETRY_ATTEMPTS = 1).
 * Allowed values are 0-3 (validated at the API layer via RETRY_ATTEMPT_OPTIONS).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      ADD COLUMN IF NOT EXISTS llm_retry_attempts integer;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE workspace_settings
      DROP COLUMN IF EXISTS llm_retry_attempts;
  `);
};
