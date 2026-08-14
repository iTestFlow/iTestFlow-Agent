/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE playwright_mcp_configs (
      workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      transport text NOT NULL CHECK (transport IN ('http', 'stdio')),
      endpoint text,
      artifact_base_url text,
      encrypted_bearer_token text,
      bearer_token_iv text,
      bearer_token_tag text,
      bearer_token_key_version integer,
      enabled boolean NOT NULL DEFAULT true,
      created_by_user_id text NOT NULL REFERENCES users(id),
      updated_by_user_id text NOT NULL REFERENCES users(id),
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CHECK (
        (transport = 'http' AND endpoint IS NOT NULL) OR
        (transport = 'stdio' AND endpoint IS NULL)
      ),
      CHECK (
        (encrypted_bearer_token IS NULL AND bearer_token_iv IS NULL AND bearer_token_tag IS NULL AND bearer_token_key_version IS NULL) OR
        (encrypted_bearer_token IS NOT NULL AND bearer_token_iv IS NOT NULL AND bearer_token_tag IS NOT NULL AND bearer_token_key_version IS NOT NULL)
      )
    );

    CREATE TABLE playwright_execution_runs (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      azure_plan_id integer NOT NULL,
      azure_suite_id integer NOT NULL,
      status text NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'blocked', 'timeout', 'cancelled', 'error')),
      requested_by_user_id text NOT NULL REFERENCES users(id),
      job_id text REFERENCES jobs(id) ON DELETE SET NULL,
      cancel_requested boolean NOT NULL DEFAULT false,
      total_cases integer NOT NULL DEFAULT 0,
      completed_cases integer NOT NULL DEFAULT 0,
      config_snapshot_json jsonb NOT NULL DEFAULT '{}',
      error_message text,
      started_at text,
      finished_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE INDEX idx_playwright_runs_scope ON playwright_execution_runs (workspace_id, project_id, created_at DESC);
    CREATE UNIQUE INDEX uq_playwright_active_project_run ON playwright_execution_runs (workspace_id, project_id)
      WHERE status IN ('queued', 'running');

    CREATE TABLE playwright_execution_cases (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES playwright_execution_runs(id) ON DELETE CASCADE,
      azure_test_case_id integer NOT NULL,
      azure_test_point_id integer,
      azure_suite_id integer NOT NULL,
      title text NOT NULL,
      status text NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'blocked', 'timeout', 'cancelled', 'error')),
      duration_ms integer,
      error_message text,
      started_at text,
      finished_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );
    CREATE INDEX idx_playwright_cases_run ON playwright_execution_cases (run_id, created_at);

    CREATE TABLE playwright_execution_steps (
      id text PRIMARY KEY,
      case_id text NOT NULL REFERENCES playwright_execution_cases(id) ON DELETE CASCADE,
      step_index integer NOT NULL,
      action text NOT NULL,
      expected_result text,
      status text NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'blocked', 'timeout', 'cancelled', 'error')),
      tool_name text,
      tool_arguments_json jsonb,
      tool_result_json jsonb,
      duration_ms integer,
      error_message text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (case_id, step_index)
    );

    CREATE TABLE playwright_execution_artifacts (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES playwright_execution_runs(id) ON DELETE CASCADE,
      case_id text REFERENCES playwright_execution_cases(id) ON DELETE CASCADE,
      step_id text REFERENCES playwright_execution_steps(id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('screenshot', 'trace', 'video', 'log')),
      sha256 text NOT NULL,
      storage_key text NOT NULL,
      mime_type text NOT NULL,
      byte_size bigint NOT NULL,
      source_url text,
      created_at text NOT NULL
    );
    CREATE INDEX idx_playwright_artifacts_digest ON playwright_execution_artifacts (workspace_id, sha256);

    CREATE TABLE playwright_execution_publications (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES playwright_execution_runs(id) ON DELETE CASCADE,
      published_by_user_id text NOT NULL REFERENCES users(id),
      status text NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
      result_json jsonb NOT NULL DEFAULT '[]',
      lease_token text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      finished_at text
    );
    CREATE UNIQUE INDEX uq_playwright_publication_run ON playwright_execution_publications (run_id);
    CREATE INDEX idx_playwright_publications_run ON playwright_execution_publications (run_id, created_at DESC);

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
    CREATE TRIGGER trg_playwright_execution_job_terminalize
      AFTER UPDATE OF status ON jobs
      FOR EACH ROW EXECUTE FUNCTION playwright_execution_job_terminalize();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS trg_playwright_execution_job_terminalize ON jobs;
    DROP FUNCTION IF EXISTS playwright_execution_job_terminalize();
    DROP TABLE IF EXISTS playwright_execution_publications CASCADE;
    DROP TABLE IF EXISTS playwright_execution_artifacts CASCADE;
    DROP TABLE IF EXISTS playwright_execution_steps CASCADE;
    DROP TABLE IF EXISTS playwright_execution_cases CASCADE;
    DROP TABLE IF EXISTS playwright_execution_runs CASCADE;
    DROP TABLE IF EXISTS playwright_mcp_configs CASCADE;
  `);
};
