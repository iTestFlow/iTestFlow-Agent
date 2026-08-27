/* eslint-disable camelcase */

exports.shorthands = undefined;

// Site-before-OAuth (issue #186): /api/auth/jira/start records the site the
// user chose on the login page so the callback can verify the authenticated
// account actually has access to that exact site and never silently switch to
// another. Plaintext by design: the URL is a non-secret display value and the
// workspace id is an opaque internal reference. The row lives for at most ten
// minutes keyed by hashed state; deleting the workspace also deletes its
// in-flight states so callbacks fail closed.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE jira_oauth_states ADD COLUMN selected_site_url text;
    ALTER TABLE jira_oauth_states
      ADD COLUMN selected_workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE jira_oauth_states DROP COLUMN IF EXISTS selected_workspace_id;
    ALTER TABLE jira_oauth_states DROP COLUMN IF EXISTS selected_site_url;
  `);
};
