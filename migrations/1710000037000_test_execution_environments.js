/* eslint-disable camelcase */

/**
 * Test Execution Phase 1 — environment profiles and their secrets.
 *
 * An environment profile describes where and how a test run executes: target
 * URL, allowed origin, browser options, evidence policy, and an optional login
 * sequence authored once per environment. Secrets are user-defined key/value
 * pairs (AES-256-GCM, same column convention as user_credentials in
 * 1710000002000) referenced from plans as {{secret:NAME}} placeholders; the
 * ciphertext is resolved only inside the execution worker and APIs expose only
 * masked_preview.
 *
 * The composite project-scope FK relies on the unique index
 * idx_projects_document_source_scope created in 1710000033000.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS test_environment_profiles (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      name text NOT NULL CHECK (name <> ''),
      initial_url text NOT NULL CHECK (initial_url <> ''),
      allowed_origin text NOT NULL CHECK (allowed_origin <> ''),
      viewport_width integer NOT NULL DEFAULT 1280
        CHECK (viewport_width BETWEEN 320 AND 3840),
      viewport_height integer NOT NULL DEFAULT 720
        CHECK (viewport_height BETWEEN 320 AND 3840),
      headless boolean NOT NULL DEFAULT true,
      default_timeout_ms integer NOT NULL DEFAULT 10000
        CHECK (default_timeout_ms BETWEEN 500 AND 60000),
      navigation_timeout_ms integer NOT NULL DEFAULT 30000
        CHECK (navigation_timeout_ms BETWEEN 1000 AND 120000),
      evidence_level text NOT NULL DEFAULT 'on_failure'
        CHECK (evidence_level IN ('minimal', 'on_failure', 'all_steps')),
      login_plan_json jsonb,
      lifecycle_status text NOT NULL DEFAULT 'active'
        CHECK (lifecycle_status IN ('active', 'archived')),
      archived_at text,
      archived_by text,
      created_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_test_environment_profiles_login_plan_object
        CHECK (login_plan_json IS NULL OR jsonb_typeof(login_plan_json) = 'object'),
      CONSTRAINT chk_test_environment_profiles_archive_state
        CHECK (
          (lifecycle_status = 'active'
            AND archived_at IS NULL
            AND archived_by IS NULL)
          OR (lifecycle_status = 'archived' AND archived_at IS NOT NULL)
        ),
      CONSTRAINT fk_test_environment_profiles_project_scope
        FOREIGN KEY (project_id, workspace_id, azure_project_id)
        REFERENCES projects (id, workspace_id, azure_project_id)
        ON DELETE RESTRICT,
      CONSTRAINT uq_test_environment_profiles_scope_identity
        UNIQUE (id, workspace_id, project_id, azure_project_id),
      CONSTRAINT uq_test_environment_profiles_name
        UNIQUE (workspace_id, project_id, azure_project_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_test_environment_profiles_lifecycle
      ON test_environment_profiles (
        workspace_id,
        project_id,
        azure_project_id,
        lifecycle_status,
        updated_at DESC
      );

    /*
     * secret_name is the token used inside {{secret:NAME}} placeholders, so it
     * is constrained to an env-var-like shape that survives verbatim inside
     * plan JSON and never needs escaping.
     */
    CREATE TABLE IF NOT EXISTS test_environment_secrets (
      id text PRIMARY KEY,
      profile_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      secret_name text NOT NULL CHECK (secret_name ~ '^[A-Z][A-Z0-9_]{0,63}$'),
      title text NOT NULL CHECK (title <> ''),
      encrypted_secret text NOT NULL,
      encryption_iv text NOT NULL,
      encryption_tag text NOT NULL,
      key_version integer NOT NULL DEFAULT 1,
      masked_preview text NOT NULL,
      created_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT fk_test_environment_secrets_profile_scope
        FOREIGN KEY (profile_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_environment_profiles (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_environment_secrets_name
        UNIQUE (profile_id, secret_name)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS test_environment_secrets;
    DROP INDEX IF EXISTS idx_test_environment_profiles_lifecycle;
    DROP TABLE IF EXISTS test_environment_profiles;
  `);
};
