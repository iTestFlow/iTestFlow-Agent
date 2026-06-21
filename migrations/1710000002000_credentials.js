/* eslint-disable camelcase */

/**
 * Phase 2 — encrypted credentials & per-user LLM settings.
 *
 * Secrets (Azure PAT, LLM API key) are stored AES-256-GCM encrypted: ciphertext,
 * iv, and tag in separate columns, with a key_version for future key rotation.
 * The encryption key lives in APP_ENCRYPTION_KEY (env / secret manager), never in
 * the database or app data folder. APIs expose only masked_preview + status.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE user_credentials (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_type text NOT NULL CHECK (credential_type IN ('azure_pat', 'llm_api_key')),
      provider text,
      encrypted_secret text NOT NULL,
      encryption_iv text NOT NULL,
      encryption_tag text NOT NULL,
      key_version integer NOT NULL DEFAULT 1,
      masked_preview text,
      status text NOT NULL DEFAULT 'configured',
      last_validated_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    -- One credential per (workspace, user, type, provider); COALESCE so a NULL
    -- provider (azure_pat) still collapses to a single row per user/workspace.
    CREATE UNIQUE INDEX uq_user_credentials
      ON user_credentials (workspace_id, user_id, credential_type, COALESCE(provider, ''));

    CREATE TABLE user_llm_settings (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider text NOT NULL,
      model text NOT NULL,
      base_url text,
      temperature double precision,
      max_output_tokens integer,
      is_default integer NOT NULL DEFAULT 0,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (workspace_id, user_id, provider)
    );
    CREATE INDEX idx_user_llm_settings_default
      ON user_llm_settings (workspace_id, user_id, is_default);

    CREATE TABLE workspace_credentials (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      credential_type text NOT NULL DEFAULT 'azure_pat',
      provider text,
      encrypted_secret text NOT NULL,
      encryption_iv text NOT NULL,
      encryption_tag text NOT NULL,
      key_version integer NOT NULL DEFAULT 1,
      masked_preview text,
      created_by_user_id text REFERENCES users(id),
      last_validated_at text,
      status text NOT NULL DEFAULT 'configured',
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (workspace_id, credential_type)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS workspace_credentials CASCADE;
    DROP TABLE IF EXISTS user_llm_settings CASCADE;
    DROP TABLE IF EXISTS user_credentials CASCADE;
  `);
};
