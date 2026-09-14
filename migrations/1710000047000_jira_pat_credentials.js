/* eslint-disable camelcase */

/**
 * Jira per-user API tokens replace OAuth (pre-release, destructive).
 *
 * Jira support is unreleased: OAuth state/selection escrow, webhook
 * registrations/events, and OAuth-shaped connections carry no data worth a
 * compatibility migration. jira_connections is rebuilt for Basic-auth API
 * tokens: normalized login email, one encrypted token (nullable so revocation
 * genuinely clears secrets, with a CHECK that an active row carries the full
 * encrypted set), the detected token kind (scoped tokens call the
 * api.atlassian.com gateway; classic tokens call the site URL), and an
 * active|invalid|revoked lifecycle. jobs.error_code carries typed failure
 * codes (e.g. jira_sync_principal_invalid) to the workspace jobs surface.
 *
 * Preserved (NOT touched here): jira_sync_mappings, jira_sync_field_states,
 * jira_sync_operations, jira_project_sync_configs, jira_artifact_backend_configs,
 * jira_artifact_links, external_identities, and the workspaces/projects provider
 * columns with their unique indexes. In particular the projects composite-identity
 * index created alongside the webhook tables in 1710000039000 backs FKs of four
 * preserved tables and must survive.
 *
 * down() recreates every dropped structure empty so the down-chain
 * (db:reset-dev/db:reset:test run `down 999999`) stays runnable; the dropped
 * OAuth secrets and webhook events are not recoverable. The branch-only
 * 1710000046000 migration (jira_oauth_states site columns) was deleted with the
 * OAuth flow; fix-migration-history removes its orphaned record.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS jira_oauth_selections;
    DROP TABLE IF EXISTS jira_oauth_states;
    DROP TABLE IF EXISTS jira_webhook_events;
    DROP TABLE IF EXISTS jira_webhooks;
    DELETE FROM jobs WHERE job_type = 'jira_webhook_reconcile';

    DROP TABLE IF EXISTS jira_connections;
    CREATE TABLE jira_connections (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      cloud_id text NOT NULL,
      email text NOT NULL,
      token_kind text NOT NULL CHECK (token_kind IN ('scoped', 'classic')),
      encrypted_api_token text,
      api_token_iv text,
      api_token_tag text,
      key_version integer,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invalid', 'revoked')),
      is_sync_principal boolean NOT NULL DEFAULT false,
      last_validated_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      revoked_at text,
      UNIQUE (workspace_id, user_id),
      CHECK (
        status <> 'active'
        OR (
          encrypted_api_token IS NOT NULL
          AND api_token_iv IS NOT NULL
          AND api_token_tag IS NOT NULL
          AND key_version IS NOT NULL
        )
      )
    );
    CREATE UNIQUE INDEX idx_jira_connections_sync_principal
      ON jira_connections(workspace_id)
      WHERE is_sync_principal = true AND status = 'active';

    ALTER TABLE jobs ADD COLUMN error_code text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE jobs DROP COLUMN IF EXISTS error_code;

    DROP TABLE IF EXISTS jira_connections;
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

    CREATE TABLE jira_webhooks (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id text NOT NULL,
      cloud_id text NOT NULL,
      webhook_id text,
      expires_at text,
      status text NOT NULL DEFAULT 'registering' CHECK (status IN ('registering', 'active', 'renewal_required', 'registration_error', 'disabled')),
      last_error_code text,
      callback_key_hash text NOT NULL UNIQUE,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (cloud_id, webhook_id),
      UNIQUE (workspace_id, project_id),
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
    );
    CREATE INDEX idx_jira_webhooks_renewal ON jira_webhooks(status, expires_at);

    CREATE TABLE jira_webhook_events (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id text NOT NULL,
      cloud_id text NOT NULL,
      delivery_id text NOT NULL,
      event_type text NOT NULL,
      issue_id text,
      payload_hash text NOT NULL,
      payload_json text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      retry_count integer NOT NULL DEFAULT 0,
      received_at text NOT NULL,
      processed_at text,
      error_code text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (cloud_id, delivery_id),
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
    );
    CREATE INDEX idx_jira_webhook_events_pending ON jira_webhook_events(status, received_at);
  `);
};
