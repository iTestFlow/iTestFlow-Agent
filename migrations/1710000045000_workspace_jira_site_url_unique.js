/* eslint-disable camelcase */

exports.shorthands = undefined;

// Jira site bootstrap (issue #186): BOOTSTRAP_JIRA_SITES seeds jira-cloud
// workspace rows keyed by their normalized site URL before the Atlassian
// cloudId is known (provider_site_id stays NULL until the first OAuth grant
// adopts the row). That makes the site URL a second identity key, so it must
// be normalized and unique per provider. Azure rows are untouched: backfilled
// rows mirror the already-unique azure_org_url, and rows created after the
// jira_oauth_identity migration keep provider_site_url NULL (excluded by the
// partial predicate).
exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM workspaces
        WHERE provider_id = 'jira-cloud' AND provider_site_url IS NOT NULL
        GROUP BY LOWER(TRIM(TRAILING '/' FROM provider_site_url))
        HAVING COUNT(*) > 1
      ) THEN
        RAISE EXCEPTION 'Resolve duplicate Jira site URLs before applying the Jira site bootstrap migration';
      END IF;
    END
    $$;
    UPDATE workspaces
    SET provider_site_url = LOWER(TRIM(TRAILING '/' FROM provider_site_url))
    WHERE provider_id = 'jira-cloud' AND provider_site_url IS NOT NULL;
    CREATE UNIQUE INDEX idx_workspaces_provider_site_url
      ON workspaces(provider_id, provider_site_url)
      WHERE provider_site_url IS NOT NULL;
  `);
};

// The URL normalization is not reversed on rollback: the lowercase, slash-free
// form is semantically identical for Atlassian site URLs and remains valid for
// every pre-migration reader.
exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_workspaces_provider_site_url;
  `);
};
