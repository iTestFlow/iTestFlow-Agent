/* eslint-disable camelcase */

/**
 * Test Execution Phase 1 — runs and their execution chain.
 *
 * A run is created only at explicit user approval and freezes everything it
 * needs: non-secret environment config (env_config_json, including the login
 * plan), a per-run copy of the secrets (test_execution_run_secrets — AES-GCM
 * rows are location-independent, so profile rows are copied verbatim and
 * later profile edits never affect an in-flight run), immutable Azure source
 * snapshots, and the compiled per-case plans. Job lifecycle stays in `jobs`;
 * run/case/step rows carry the test-outcome taxonomy, which is deliberately
 * richer than job status (a failed test is a completed job).
 *
 * Secrets appear in plans only as {{secret:NAME}} placeholders; resolved
 * values are never persisted in action_json, observation_json, or artifacts.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS test_execution_runs (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      environment_profile_id text,
      env_config_json jsonb NOT NULL,
      story_work_item_id text,
      story_title text,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'canceled', 'error')),
      outcome text
        CHECK (outcome IN (
          'passed', 'failed', 'blocked', 'infrastructure_error',
          'timeout', 'canceled', 'needs_review'
        )),
      summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      job_id text,
      plan_schema_version text NOT NULL DEFAULT 'v1',
      approved_by text NOT NULL,
      approved_at text NOT NULL,
      started_at text,
      finished_at text,
      error_message text,
      created_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_test_execution_runs_env_config_object
        CHECK (jsonb_typeof(env_config_json) = 'object'),
      CONSTRAINT chk_test_execution_runs_summary_object
        CHECK (jsonb_typeof(summary_json) = 'object'),
      CONSTRAINT chk_test_execution_runs_outcome_terminal
        CHECK (outcome IS NULL OR status IN ('completed', 'canceled', 'error')),
      CONSTRAINT fk_test_execution_runs_project_scope
        FOREIGN KEY (project_id, workspace_id, azure_project_id)
        REFERENCES projects (id, workspace_id, azure_project_id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_test_execution_runs_environment_scope
        FOREIGN KEY (environment_profile_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_environment_profiles (id, workspace_id, project_id, azure_project_id)
        ON DELETE RESTRICT,
      CONSTRAINT uq_test_execution_runs_scope_identity
        UNIQUE (id, workspace_id, project_id, azure_project_id)
    );

    /*
     * One active run per project, enforced in the database as defense-in-depth
     * behind the jobs dedupe key test_execution:<projectId>. projects.id is a
     * global primary key, so project_id alone is sufficient here.
     */
    CREATE UNIQUE INDEX IF NOT EXISTS uq_test_execution_runs_active_project
      ON test_execution_runs (project_id)
      WHERE status IN ('queued', 'running');

    CREATE INDEX IF NOT EXISTS idx_test_execution_runs_list
      ON test_execution_runs (
        workspace_id,
        project_id,
        azure_project_id,
        created_at DESC
      );

    CREATE TABLE IF NOT EXISTS test_execution_run_secrets (
      id text PRIMARY KEY,
      run_id text NOT NULL,
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
      created_at text NOT NULL,
      CONSTRAINT fk_test_execution_run_secrets_run_scope
        FOREIGN KEY (run_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_execution_runs (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_execution_run_secrets_name
        UNIQUE (run_id, secret_name)
    );

    CREATE TABLE IF NOT EXISTS test_execution_source_snapshots (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('user_story', 'test_case')),
      azure_work_item_id text NOT NULL,
      azure_revision integer,
      payload_json jsonb NOT NULL,
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      created_at text NOT NULL,
      CONSTRAINT chk_test_execution_source_snapshots_payload_object
        CHECK (jsonb_typeof(payload_json) = 'object'),
      CONSTRAINT fk_test_execution_source_snapshots_run_scope
        FOREIGN KEY (run_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_execution_runs (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_execution_source_snapshots_identity
        UNIQUE (run_id, kind, azure_work_item_id)
    );

    /*
     * Source snapshots are the audit anchor for what exactly was executed.
     * They are write-once: rows are only ever removed by deleting the whole
     * run (CASCADE), and no column may change after insert.
     */
    CREATE OR REPLACE FUNCTION prevent_test_execution_source_snapshot_mutation()
    RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION
        'Test execution source snapshots are immutable.'
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_test_execution_source_snapshots_immutable
      ON test_execution_source_snapshots;
    CREATE TRIGGER trg_test_execution_source_snapshots_immutable
      BEFORE UPDATE ON test_execution_source_snapshots
      FOR EACH ROW
      EXECUTE FUNCTION prevent_test_execution_source_snapshot_mutation();

    CREATE TABLE IF NOT EXISTS test_execution_case_runs (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      order_index integer NOT NULL CHECK (order_index >= 0),
      source_kind text NOT NULL CHECK (source_kind IN ('azure_test_case', 'manual')),
      /*
       * SET NULL keeps run-deletion cascades order-independent: snapshots and
       * case runs both cascade from the run, and snapshots are never deleted
       * individually (immutability trigger + no delete path).
       */
      source_snapshot_id text
        REFERENCES test_execution_source_snapshots (id) ON DELETE SET NULL,
      title text NOT NULL CHECK (title <> ''),
      compiled_plan_json jsonb NOT NULL,
      compile_source text NOT NULL
        CHECK (compile_source IN ('manual_typed', 'llm_compiled')),
      compile_prompt_version text,
      compile_model text,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed')),
      outcome text
        CHECK (outcome IN (
          'passed', 'failed_assertion', 'blocked_policy', 'blocked_prerequisite',
          'infrastructure_error', 'timeout', 'canceled', 'skipped',
          'not_run', 'needs_review'
        )),
      error_message text,
      started_at text,
      finished_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_test_execution_case_runs_plan_object
        CHECK (jsonb_typeof(compiled_plan_json) = 'object'),
      CONSTRAINT chk_test_execution_case_runs_outcome_terminal
        CHECK (outcome IS NULL OR status = 'completed'),
      CONSTRAINT fk_test_execution_case_runs_run_scope
        FOREIGN KEY (run_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_execution_runs (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_execution_case_runs_order
        UNIQUE (run_id, order_index),
      /* Used by step runs' composite foreign key. */
      CONSTRAINT uq_test_execution_case_runs_run_identity
        UNIQUE (id, run_id)
    );

    CREATE TABLE IF NOT EXISTS test_execution_step_runs (
      id text PRIMARY KEY,
      case_run_id text NOT NULL,
      run_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      order_index integer NOT NULL CHECK (order_index >= 0),
      action_json jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'completed')),
      outcome text
        CHECK (outcome IN (
          'passed', 'failed_assertion', 'blocked_policy', 'blocked_prerequisite',
          'infrastructure_error', 'timeout', 'canceled', 'skipped',
          'not_run', 'needs_review'
        )),
      observation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      error_message text,
      started_at text,
      finished_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_test_execution_step_runs_action_object
        CHECK (jsonb_typeof(action_json) = 'object'),
      CONSTRAINT chk_test_execution_step_runs_observation_object
        CHECK (jsonb_typeof(observation_json) = 'object'),
      CONSTRAINT chk_test_execution_step_runs_outcome_terminal
        CHECK (outcome IS NULL OR status = 'completed'),
      CONSTRAINT fk_test_execution_step_runs_case
        FOREIGN KEY (case_run_id, run_id)
        REFERENCES test_execution_case_runs (id, run_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_execution_step_runs_order
        UNIQUE (case_run_id, order_index)
    );

    CREATE INDEX IF NOT EXISTS idx_test_execution_step_runs_run
      ON test_execution_step_runs (run_id);

    CREATE TABLE IF NOT EXISTS test_execution_artifacts (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      case_run_id text
        REFERENCES test_execution_case_runs (id) ON DELETE SET NULL,
      step_run_id text
        REFERENCES test_execution_step_runs (id) ON DELETE SET NULL,
      kind text NOT NULL CHECK (kind IN ('screenshot', 'console_log')),
      storage_backend text NOT NULL DEFAULT 'local_fs'
        CHECK (storage_backend IN ('local_fs', 's3', 'azure_blob')),
      storage_key text NOT NULL CHECK (storage_key <> ''),
      content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      mime_type text NOT NULL CHECK (mime_type <> ''),
      byte_size bigint NOT NULL CHECK (byte_size >= 0),
      file_name text NOT NULL CHECK (file_name <> ''),
      created_by_worker text,
      created_at text NOT NULL,
      CONSTRAINT fk_test_execution_artifacts_run_scope
        FOREIGN KEY (run_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_execution_runs (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_test_execution_artifacts_run
      ON test_execution_artifacts (run_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_test_execution_artifacts_step
      ON test_execution_artifacts (step_run_id)
      WHERE step_run_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_test_execution_artifacts_case
      ON test_execution_artifacts (case_run_id)
      WHERE case_run_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_test_execution_artifacts_case;
    DROP INDEX IF EXISTS idx_test_execution_artifacts_step;
    DROP INDEX IF EXISTS idx_test_execution_artifacts_run;
    DROP TABLE IF EXISTS test_execution_artifacts;

    DROP INDEX IF EXISTS idx_test_execution_step_runs_run;
    DROP TABLE IF EXISTS test_execution_step_runs;
    DROP TABLE IF EXISTS test_execution_case_runs;

    DROP TRIGGER IF EXISTS trg_test_execution_source_snapshots_immutable
      ON test_execution_source_snapshots;
    DROP FUNCTION IF EXISTS prevent_test_execution_source_snapshot_mutation();
    DROP TABLE IF EXISTS test_execution_source_snapshots;

    DROP TABLE IF EXISTS test_execution_run_secrets;

    DROP INDEX IF EXISTS idx_test_execution_runs_list;
    DROP INDEX IF EXISTS uq_test_execution_runs_active_project;
    DROP TABLE IF EXISTS test_execution_runs;
  `);
};
