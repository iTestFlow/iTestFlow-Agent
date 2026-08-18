/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE playwright_execution_runs
      ALTER COLUMN azure_plan_id DROP NOT NULL,
      ALTER COLUMN azure_suite_id DROP NOT NULL,
      ADD COLUMN base_url text,
      ADD COLUMN execution_notes text,
      ADD COLUMN screenshot_policy text NOT NULL DEFAULT 'validation-points'
        CHECK (screenshot_policy IN ('every-step', 'validation-points', 'failures-only', 'none'));

    ALTER TABLE playwright_execution_cases
      ALTER COLUMN azure_test_case_id DROP NOT NULL,
      ALTER COLUMN azure_suite_id DROP NOT NULL,
      ADD COLUMN azure_plan_id integer;

    -- Pre-workbench cases always belonged to their run's single plan; backfill so
    -- the per-case publish identity keeps legacy runs publishable and rerunnable.
    UPDATE playwright_execution_cases c
       SET azure_plan_id = r.azure_plan_id
      FROM playwright_execution_runs r
     WHERE r.id = c.run_id AND c.azure_plan_id IS NULL;

    CREATE TABLE playwright_execution_run_data (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES playwright_execution_runs(id) ON DELETE CASCADE,
      position integer NOT NULL DEFAULT 0,
      title text NOT NULL,
      is_secret boolean NOT NULL DEFAULT false,
      value text,
      encrypted_value text,
      value_iv text,
      value_tag text,
      value_key_version integer,
      created_at text NOT NULL,
      CHECK (
        (is_secret AND value IS NULL AND encrypted_value IS NOT NULL AND value_iv IS NOT NULL AND value_tag IS NOT NULL AND value_key_version IS NOT NULL) OR
        (NOT is_secret AND value IS NOT NULL AND encrypted_value IS NULL AND value_iv IS NULL AND value_tag IS NULL AND value_key_version IS NULL)
      )
    );
    CREATE UNIQUE INDEX uq_playwright_run_data_title ON playwright_execution_run_data (run_id, lower(title));

    CREATE TABLE playwright_execution_profiles (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      base_url text,
      execution_notes text,
      screenshot_policy text NOT NULL DEFAULT 'validation-points'
        CHECK (screenshot_policy IN ('every-step', 'validation-points', 'failures-only', 'none')),
      created_by_user_id text NOT NULL REFERENCES users(id),
      updated_by_user_id text NOT NULL REFERENCES users(id),
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE UNIQUE INDEX uq_playwright_profile_name ON playwright_execution_profiles (workspace_id, project_id, lower(name));

    CREATE TABLE playwright_execution_profile_data (
      id text PRIMARY KEY,
      profile_id text NOT NULL REFERENCES playwright_execution_profiles(id) ON DELETE CASCADE,
      position integer NOT NULL DEFAULT 0,
      title text NOT NULL,
      is_secret boolean NOT NULL DEFAULT false,
      value text,
      encrypted_value text,
      value_iv text,
      value_tag text,
      value_key_version integer,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CHECK (
        (is_secret AND value IS NULL AND encrypted_value IS NOT NULL AND value_iv IS NOT NULL AND value_tag IS NOT NULL AND value_key_version IS NOT NULL) OR
        (NOT is_secret AND value IS NOT NULL AND encrypted_value IS NULL AND value_iv IS NULL AND value_tag IS NULL AND value_key_version IS NULL)
      )
    );
    CREATE UNIQUE INDEX uq_playwright_profile_data_title ON playwright_execution_profile_data (profile_id, lower(title));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS playwright_execution_profile_data CASCADE;
    DROP TABLE IF EXISTS playwright_execution_profiles CASCADE;
    DROP TABLE IF EXISTS playwright_execution_run_data CASCADE;

    ALTER TABLE playwright_execution_runs
      DROP COLUMN IF EXISTS base_url,
      DROP COLUMN IF EXISTS execution_notes,
      DROP COLUMN IF EXISTS screenshot_policy;

    ALTER TABLE playwright_execution_cases
      DROP COLUMN IF EXISTS azure_plan_id;
  `);
};
