/* eslint-disable camelcase */

/**
 * Test Execution — login session reuse + named test users (AgentEx
 * optimize-login mimic, adapted to the encrypted server-side model).
 *
 * test_environment_sessions holds ONE encrypted browser storage-state per
 * environment profile (cookies/localStorage captured after a verified
 * login). Reuse is gated by the profile's logged_in_text landmark — session
 * validity is proven by an authenticated-only text on the page, never by
 * URL. users_json holds named test users (handle + username + password
 * secret NAME); secret values stay in test_environment_secrets.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE test_environment_profiles
      ADD COLUMN IF NOT EXISTS login_mode text NOT NULL DEFAULT 'session',
      ADD COLUMN IF NOT EXISTS logged_in_text text,
      ADD COLUMN IF NOT EXISTS users_json jsonb NOT NULL DEFAULT '[]'::jsonb;

    ALTER TABLE test_environment_profiles
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_login_mode;
    ALTER TABLE test_environment_profiles
      ADD CONSTRAINT chk_test_environment_profiles_login_mode
      CHECK (login_mode IN ('session', 'fresh')) NOT VALID;
    ALTER TABLE test_environment_profiles
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_users_array;
    ALTER TABLE test_environment_profiles
      ADD CONSTRAINT chk_test_environment_profiles_users_array
      CHECK (jsonb_typeof(users_json) = 'array') NOT VALID;

    CREATE TABLE IF NOT EXISTS test_environment_sessions (
      id text PRIMARY KEY,
      profile_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      encrypted_state text NOT NULL,
      encryption_iv text NOT NULL,
      encryption_tag text NOT NULL,
      key_version integer NOT NULL DEFAULT 1,
      captured_at text NOT NULL,
      expires_at text NOT NULL,
      last_used_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT fk_test_environment_sessions_profile_scope
        FOREIGN KEY (profile_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_environment_profiles (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_environment_sessions_profile
        UNIQUE (profile_id)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS test_environment_sessions;
    ALTER TABLE test_environment_profiles
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_users_array;
    ALTER TABLE test_environment_profiles
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_login_mode;
    ALTER TABLE test_environment_profiles
      DROP COLUMN IF EXISTS users_json,
      DROP COLUMN IF EXISTS logged_in_text,
      DROP COLUMN IF EXISTS login_mode;
  `);
};
