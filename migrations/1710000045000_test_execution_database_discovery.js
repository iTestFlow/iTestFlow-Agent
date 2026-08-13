/* eslint-disable camelcase */

/**
 * Test Execution — per-run database object discovery.
 *
 * Replaces the tester-managed "Allowed schemas" list: the run's own database
 * account is asked which non-system objects it can actually see, once per run.
 * The recorded row IS the per-run cache — a reclaimed worker reuses it instead
 * of re-discovering, so a run's database surface can never widen mid-flight.
 *
 * Failure detail is deliberately a classified code plus a bounded, scrubbed
 * excerpt: raw driver exceptions can carry connection strings and data.
 *
 * FOLLOW-UP CLEANUP (deliberately NOT done here): the tester-facing egress and
 * capability-catalog surfaces were removed in the same change, but their tables
 * stay so historical runs remain readable and executable.
 *   - workspace_test_egress_rules: dormant, drops cleanly whenever wanted.
 *   - test_integration_operation_revisions: CANNOT drop while
 *     test_execution_run_capabilities rows reference it (ON DELETE RESTRICT).
 *     A cleanup migration must archive or detach those pins first.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS test_execution_run_database_discovery (
      id text PRIMARY KEY,
      run_id text NOT NULL UNIQUE REFERENCES test_execution_runs(id) ON DELETE CASCADE,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      driver text NOT NULL,
      status text NOT NULL,
      error_code text,
      error_message text,
      truncated boolean NOT NULL DEFAULT false,
      object_count integer NOT NULL DEFAULT 0,
      objects_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at text NOT NULL,
      CONSTRAINT chk_test_execution_run_database_discovery_driver
        CHECK (driver IN ('postgres', 'sqlserver', 'mysql')),
      CONSTRAINT chk_test_execution_run_database_discovery_status
        CHECK (status IN ('succeeded', 'failed')),
      CONSTRAINT chk_test_execution_run_database_discovery_objects
        CHECK (jsonb_typeof(objects_json) = 'array'),
      CONSTRAINT chk_test_execution_run_database_discovery_object_count
        CHECK (object_count >= 0)
    );

    CREATE INDEX IF NOT EXISTS idx_test_execution_run_database_discovery_scope
      ON test_execution_run_database_discovery (workspace_id, project_id, azure_project_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS test_execution_run_database_discovery;`);
};
