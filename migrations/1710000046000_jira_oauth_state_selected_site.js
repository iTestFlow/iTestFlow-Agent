/* eslint-disable camelcase */

exports.shorthands = undefined;

// Site-before-OAuth (issue #186): /api/auth/jira/start records the site the
// user chose on the login page so the callback can verify the authenticated
// account actually has access to that exact site and never silently switch to
// another. Plaintext by design: the value is a non-secret display URL of a
// deployment-enabled site, and the row lives for at most ten minutes keyed by
// hashed state.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE jira_oauth_states ADD COLUMN selected_site_url text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE jira_oauth_states DROP COLUMN IF EXISTS selected_site_url;
  `);
};
