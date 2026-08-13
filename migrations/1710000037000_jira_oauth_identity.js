/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE external_identities (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_id text NOT NULL,
      provider_subject text NOT NULL,
      email text,
      display_name text,
      created_at text NOT NULL,
      last_login_at text NOT NULL,
      UNIQUE (provider_id, provider_subject)
    );
    CREATE UNIQUE INDEX idx_users_email_ci
      ON users(LOWER(email_or_unique_name))
      WHERE email_or_unique_name IS NOT NULL;

    INSERT INTO external_identities (
      id, user_id, provider_id, provider_subject, email, display_name, created_at, last_login_at
    )
    SELECT 'extid_' || id, id, 'azure-devops', azure_identity_id,
           email_or_unique_name, display_name, created_at, COALESCE(last_login_at, created_at)
    FROM users
    WHERE azure_identity_id IS NOT NULL
    ON CONFLICT (provider_id, provider_subject) DO NOTHING;

    ALTER TABLE workspaces ADD COLUMN provider_site_id text;
    ALTER TABLE workspaces ADD COLUMN provider_site_name text;
    ALTER TABLE workspaces ADD COLUMN provider_site_url text;
    UPDATE workspaces
    SET provider_site_id = azure_org_url,
        provider_site_name = azure_org_name,
        provider_site_url = azure_org_url
    WHERE provider_id = 'azure-devops';
    ALTER TABLE workspaces ALTER COLUMN azure_org_name DROP NOT NULL;
    ALTER TABLE workspaces ALTER COLUMN azure_org_url DROP NOT NULL;
    CREATE UNIQUE INDEX idx_workspaces_provider_site
      ON workspaces(provider_id, provider_site_id)
      WHERE provider_site_id IS NOT NULL;

    CREATE TABLE jira_oauth_states (
      id text PRIMARY KEY,
      state_hash text NOT NULL UNIQUE,
      browser_binding_hash text NOT NULL,
      return_to text NOT NULL,
      created_at text NOT NULL,
      expires_at text NOT NULL
    );
    CREATE INDEX idx_jira_oauth_states_expiry ON jira_oauth_states(expires_at);

    CREATE TABLE jira_oauth_selections (
      id text PRIMARY KEY,
      continuation_hash text NOT NULL UNIQUE,
      browser_binding_hash text NOT NULL,
      encrypted_access_token text NOT NULL,
      access_token_iv text NOT NULL,
      access_token_tag text NOT NULL,
      encrypted_refresh_token text NOT NULL,
      refresh_token_iv text NOT NULL,
      refresh_token_tag text NOT NULL,
      key_version integer NOT NULL,
      access_expires_at text NOT NULL,
      scopes text NOT NULL,
      resources_json text NOT NULL,
      return_to text NOT NULL,
      created_at text NOT NULL,
      expires_at text NOT NULL
    );
    CREATE INDEX idx_jira_oauth_selections_expiry ON jira_oauth_selections(expires_at);

    CREATE TABLE jira_connections (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cloud_id text NOT NULL,
      encrypted_access_token text NOT NULL,
      access_token_iv text NOT NULL,
      access_token_tag text NOT NULL,
      encrypted_refresh_token text NOT NULL,
      refresh_token_iv text NOT NULL,
      refresh_token_tag text NOT NULL,
      key_version integer NOT NULL,
      access_expires_at text NOT NULL,
      scopes text NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauthorization_required', 'revoked')),
      is_sync_principal boolean NOT NULL DEFAULT false,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      revoked_at text,
      UNIQUE (workspace_id, user_id)
    );
    CREATE UNIQUE INDEX idx_jira_connections_sync_principal
      ON jira_connections(workspace_id)
      WHERE is_sync_principal = true AND status = 'active';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS jira_connections;
    DROP TABLE IF EXISTS jira_oauth_selections;
    DROP TABLE IF EXISTS jira_oauth_states;
    DROP INDEX IF EXISTS idx_workspaces_provider_site;
    UPDATE workspaces
    SET azure_org_name = COALESCE(azure_org_name, provider_site_name, name),
        azure_org_url = COALESCE(azure_org_url, provider_site_url, provider_site_id)
    WHERE azure_org_name IS NULL OR azure_org_url IS NULL;
    ALTER TABLE workspaces ALTER COLUMN azure_org_name SET NOT NULL;
    ALTER TABLE workspaces ALTER COLUMN azure_org_url SET NOT NULL;
    ALTER TABLE workspaces DROP COLUMN IF EXISTS provider_site_url;
    ALTER TABLE workspaces DROP COLUMN IF EXISTS provider_site_name;
    ALTER TABLE workspaces DROP COLUMN IF EXISTS provider_site_id;
    DROP TABLE IF EXISTS external_identities;
    DROP INDEX IF EXISTS idx_users_email_ci;
  `);
};
