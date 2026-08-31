/* eslint-disable camelcase */

/**
 * Dual-kind Jira credentials: OAuth 2.0 (3LO) alongside per-user API tokens.
 *
 * Additive, unlike the 47000 rebuild: jira_connections gains a credential_kind
 * discriminator (DEFAULT 'api_token', so every existing row stays valid
 * untouched) and nullable OAuth columns for the encrypted access/refresh pair
 * plus expiry. token_kind drops NOT NULL — OAuth rows carry none, and a NULL
 * passes the retained 47000 kind CHECK; the kind-hygiene constraint below is
 * what forces it NULL for OAuth rows. The two 47000 CHECKs being replaced are
 * dropped by their Postgres auto-generated names (confirmed against a live
 * replay of the 47000 DDL) and every replacement is named, so no future
 * migration guesses auto-names again:
 *   - status gains 'reauthorization_required', an OAuth-only state (a terminal
 *     refresh failure; recovery is a fresh Atlassian consent, not a token
 *     replacement) — enforced OAuth-only by chk_jira_connections_reauth_kind.
 *   - the active-row secret CHECK becomes per-kind: an active row carries the
 *     complete encrypted set for its own kind and (kind hygiene) never the
 *     other kind's secrets. Secrets stay nullable so revocation genuinely
 *     clears them.
 *
 * jira_oauth_states returns for the login flow's CSRF state, in its final
 * workspace-bound shape (site-before-OAuth): each state row pins the
 * operator-configured workspace, its canonical site URL, and the workspace's
 * pinned cloud ID (nullable — a bootstrap-seeded workspace adopts its pin on
 * first login). The post-callback multi-site selection escrow
 * (jira_oauth_selections) stays dead. The sync-principal partial unique index
 * and every preserved sync/artifact table are untouched.
 *
 * down() deletes OAuth-kind rows (their secrets cannot survive losing the
 * columns and are not recoverable), restores the 47000 constraint shapes under
 * their original auto-generated names (this migration's own up() drops by
 * those names, so up→down→up stays runnable), and drops the state table, so
 * the reset down-chain (db:reset-dev/db:reset:test run `down 999999`)
 * continues through 47000's down() unchanged.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE jira_connections
      ADD COLUMN credential_kind text NOT NULL DEFAULT 'api_token',
      ADD COLUMN encrypted_access_token text,
      ADD COLUMN access_token_iv text,
      ADD COLUMN access_token_tag text,
      ADD COLUMN encrypted_refresh_token text,
      ADD COLUMN refresh_token_iv text,
      ADD COLUMN refresh_token_tag text,
      ADD COLUMN access_expires_at text;

    ALTER TABLE jira_connections ALTER COLUMN token_kind DROP NOT NULL;

    ALTER TABLE jira_connections DROP CONSTRAINT jira_connections_status_check;
    ALTER TABLE jira_connections DROP CONSTRAINT jira_connections_check;

    ALTER TABLE jira_connections
      ADD CONSTRAINT chk_jira_connections_credential_kind CHECK (credential_kind IN ('api_token', 'oauth')),
      ADD CONSTRAINT chk_jira_connections_status CHECK (status IN ('active', 'invalid', 'reauthorization_required', 'revoked')),
      ADD CONSTRAINT chk_jira_connections_reauth_kind CHECK (status <> 'reauthorization_required' OR credential_kind = 'oauth'),
      ADD CONSTRAINT chk_jira_connections_active_secrets CHECK (
        status <> 'active'
        OR (
          credential_kind = 'api_token'
          AND token_kind IS NOT NULL
          AND encrypted_api_token IS NOT NULL
          AND api_token_iv IS NOT NULL
          AND api_token_tag IS NOT NULL
          AND key_version IS NOT NULL
        )
        OR (
          credential_kind = 'oauth'
          AND encrypted_access_token IS NOT NULL
          AND access_token_iv IS NOT NULL
          AND access_token_tag IS NOT NULL
          AND encrypted_refresh_token IS NOT NULL
          AND refresh_token_iv IS NOT NULL
          AND refresh_token_tag IS NOT NULL
          AND access_expires_at IS NOT NULL
          AND key_version IS NOT NULL
        )
      ),
      ADD CONSTRAINT chk_jira_connections_kind_hygiene CHECK (
        (
          credential_kind = 'api_token'
          AND encrypted_access_token IS NULL
          AND access_token_iv IS NULL
          AND access_token_tag IS NULL
          AND encrypted_refresh_token IS NULL
          AND refresh_token_iv IS NULL
          AND refresh_token_tag IS NULL
          AND access_expires_at IS NULL
        )
        OR (
          credential_kind = 'oauth'
          AND token_kind IS NULL
          AND encrypted_api_token IS NULL
          AND api_token_iv IS NULL
          AND api_token_tag IS NULL
        )
      );

    CREATE TABLE jira_oauth_states (
      id text PRIMARY KEY,
      state_hash text NOT NULL UNIQUE,
      browser_binding_hash text NOT NULL,
      return_to text NOT NULL,
      selected_workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      selected_site_url text NOT NULL,
      selected_cloud_id text,
      created_at text NOT NULL,
      expires_at text NOT NULL
    );
    CREATE INDEX idx_jira_oauth_states_expiry ON jira_oauth_states(expires_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS jira_oauth_states;

    DELETE FROM jira_connections WHERE credential_kind = 'oauth';

    ALTER TABLE jira_connections
      DROP CONSTRAINT chk_jira_connections_credential_kind,
      DROP CONSTRAINT chk_jira_connections_status,
      DROP CONSTRAINT chk_jira_connections_reauth_kind,
      DROP CONSTRAINT chk_jira_connections_active_secrets,
      DROP CONSTRAINT chk_jira_connections_kind_hygiene;

    ALTER TABLE jira_connections
      DROP COLUMN credential_kind,
      DROP COLUMN encrypted_access_token,
      DROP COLUMN access_token_iv,
      DROP COLUMN access_token_tag,
      DROP COLUMN encrypted_refresh_token,
      DROP COLUMN refresh_token_iv,
      DROP COLUMN refresh_token_tag,
      DROP COLUMN access_expires_at;

    ALTER TABLE jira_connections ALTER COLUMN token_kind SET NOT NULL;

    ALTER TABLE jira_connections
      ADD CONSTRAINT jira_connections_status_check CHECK (status IN ('active', 'invalid', 'revoked')),
      ADD CONSTRAINT jira_connections_check CHECK (
        status <> 'active'
        OR (
          encrypted_api_token IS NOT NULL
          AND api_token_iv IS NOT NULL
          AND api_token_tag IS NOT NULL
          AND key_version IS NOT NULL
        )
      );
  `);
};
