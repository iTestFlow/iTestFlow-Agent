/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE playwright_execution_profiles ADD COLUMN browser_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE playwright_execution_runs ADD COLUMN browser_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE playwright_execution_steps ADD COLUMN phase text NOT NULL DEFAULT 'scenario'
      CHECK (phase IN ('setup', 'scenario', 'cleanup'));

    CREATE TABLE playwright_execution_profile_connections (
      id text PRIMARY KEY,
      profile_id text NOT NULL REFERENCES playwright_execution_profiles(id) ON DELETE CASCADE,
      position integer NOT NULL,
      alias text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('api', 'database')),
      settings_json jsonb NOT NULL,
      credential_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      encrypted_credentials text,
      credentials_iv text,
      credentials_tag text,
      credentials_key_version integer,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (profile_id, alias),
      UNIQUE (profile_id, position),
      CHECK ((encrypted_credentials IS NULL AND credentials_iv IS NULL AND credentials_tag IS NULL AND credentials_key_version IS NULL)
        OR (encrypted_credentials IS NOT NULL AND credentials_iv IS NOT NULL AND credentials_tag IS NOT NULL AND credentials_key_version IS NOT NULL))
    );

    CREATE TABLE playwright_execution_run_connections (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES playwright_execution_runs(id) ON DELETE CASCADE,
      position integer NOT NULL,
      alias text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('api', 'database')),
      settings_json jsonb NOT NULL,
      credential_fields_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      encrypted_credentials text,
      credentials_iv text,
      credentials_tag text,
      credentials_key_version integer,
      created_at text NOT NULL,
      UNIQUE (run_id, alias),
      UNIQUE (run_id, position),
      CHECK ((encrypted_credentials IS NULL AND credentials_iv IS NULL AND credentials_tag IS NULL AND credentials_key_version IS NULL)
        OR (encrypted_credentials IS NOT NULL AND credentials_iv IS NOT NULL AND credentials_tag IS NOT NULL AND credentials_key_version IS NOT NULL))
    );

    CREATE TABLE playwright_execution_operations (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES playwright_execution_runs(id) ON DELETE CASCADE,
      case_id text NOT NULL REFERENCES playwright_execution_cases(id) ON DELETE CASCADE,
      step_id text NOT NULL REFERENCES playwright_execution_steps(id) ON DELETE CASCADE,
      connection_alias text,
      operation text NOT NULL,
      status text NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'uncertain')),
      evidence_json jsonb,
      error_message text,
      started_at text NOT NULL,
      finished_at text,
      duration_ms integer
    );
    CREATE INDEX idx_playwright_execution_operations_run ON playwright_execution_operations (run_id, started_at, id);

    CREATE TABLE playwright_execution_snippets (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name text NOT NULL,
      instructions text NOT NULL,
      expected_result text NOT NULL,
      created_by_user_id text NOT NULL REFERENCES users(id),
      updated_by_user_id text NOT NULL REFERENCES users(id),
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE UNIQUE INDEX uq_playwright_execution_snippet_name
      ON playwright_execution_snippets (workspace_id, project_id, lower(name));

    CREATE OR REPLACE FUNCTION playwright_execution_job_terminalize()
    RETURNS trigger AS $$
    DECLARE
      terminal_status text := CASE WHEN NEW.status = 'cancelled' THEN 'cancelled' ELSE 'error' END;
      terminal_error text := CASE WHEN NEW.status = 'cancelled'
        THEN 'Execution was cancelled.'
        ELSE COALESCE(NULLIF(NEW.error_message, ''), 'The execution worker stopped before completing the run.')
      END;
    BEGIN
      IF NEW.job_type = 'playwright_mcp_execution'
        AND NEW.status IN ('failed', 'cancelled')
        AND OLD.status IS DISTINCT FROM NEW.status THEN
        UPDATE playwright_execution_operations o
           SET status = 'uncertain', error_message = 'Worker stopped before operation completion was confirmed.', finished_at = NEW.updated_at
          FROM playwright_execution_runs r
         WHERE o.run_id = r.id AND r.job_id = NEW.id AND o.status = 'running';
        UPDATE playwright_execution_steps
           SET status = terminal_status, error_message = terminal_error, updated_at = NEW.updated_at
         WHERE status IN ('queued', 'running')
           AND case_id IN (
             SELECT execution_case.id FROM playwright_execution_cases AS execution_case
             JOIN playwright_execution_runs AS execution_run ON execution_run.id = execution_case.run_id
             WHERE execution_run.job_id = NEW.id
           );
        UPDATE playwright_execution_cases
           SET status = terminal_status, error_message = terminal_error,
               finished_at = NEW.updated_at, updated_at = NEW.updated_at
         WHERE status IN ('queued', 'running')
           AND run_id IN (SELECT id FROM playwright_execution_runs WHERE job_id = NEW.id);
        UPDATE playwright_execution_runs
           SET status = terminal_status, error_message = terminal_error,
               finished_at = NEW.updated_at, updated_at = NEW.updated_at
         WHERE job_id = NEW.id AND status IN ('queued', 'running');
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS playwright_execution_snippets;
    DROP TABLE IF EXISTS playwright_execution_operations;
    DROP TABLE IF EXISTS playwright_execution_run_connections;
    DROP TABLE IF EXISTS playwright_execution_profile_connections;
    ALTER TABLE playwright_execution_steps DROP COLUMN IF EXISTS phase;
    ALTER TABLE playwright_execution_runs DROP COLUMN IF EXISTS browser_enabled;
    ALTER TABLE playwright_execution_profiles DROP COLUMN IF EXISTS browser_enabled;
    CREATE OR REPLACE FUNCTION playwright_execution_job_terminalize()
    RETURNS trigger AS $$
    DECLARE
      terminal_status text := CASE WHEN NEW.status = 'cancelled' THEN 'cancelled' ELSE 'error' END;
      terminal_error text := CASE WHEN NEW.status = 'cancelled'
        THEN 'Execution was cancelled.'
        ELSE COALESCE(NULLIF(NEW.error_message, ''), 'The Playwright execution worker stopped before completing the run.')
      END;
    BEGIN
      IF NEW.job_type = 'playwright_mcp_execution'
        AND NEW.status IN ('failed', 'cancelled')
        AND OLD.status IS DISTINCT FROM NEW.status THEN
        UPDATE playwright_execution_steps
           SET status = terminal_status, error_message = terminal_error, updated_at = NEW.updated_at
         WHERE status IN ('queued', 'running')
           AND case_id IN (
             SELECT execution_case.id FROM playwright_execution_cases AS execution_case
             JOIN playwright_execution_runs AS execution_run ON execution_run.id = execution_case.run_id
             WHERE execution_run.job_id = NEW.id
           );
        UPDATE playwright_execution_cases
           SET status = terminal_status, error_message = terminal_error,
               finished_at = NEW.updated_at, updated_at = NEW.updated_at
         WHERE status IN ('queued', 'running')
           AND run_id IN (SELECT id FROM playwright_execution_runs WHERE job_id = NEW.id);
        UPDATE playwright_execution_runs
           SET status = terminal_status, error_message = terminal_error,
               finished_at = NEW.updated_at, updated_at = NEW.updated_at
         WHERE job_id = NEW.id AND status IN ('queued', 'running');
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
};
