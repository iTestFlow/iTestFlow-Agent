/* eslint-disable camelcase */

/**
 * Multi-org: per-session active workspace.
 *
 * When a deployment serves more than one Azure org, the org a user selects at
 * login must become the session's ACTIVE workspace so they land in (and operate
 * within) that org — instead of falling back to their oldest membership.
 *
 * Nullable + ON DELETE SET NULL: existing sessions keep NULL (resolution falls
 * back to the user's primary/oldest membership, i.e. today's behavior), and
 * deactivating/removing a workspace never breaks live sessions.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sessions
      ADD COLUMN active_workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE sessions DROP COLUMN IF EXISTS active_workspace_id;`);
};
