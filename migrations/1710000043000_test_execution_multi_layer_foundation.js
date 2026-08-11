/* eslint-disable camelcase */

/**
 * Test Execution multi-layer foundation.
 *
 * Environments may target a browser, an HTTP API, a database, or any
 * combination of the three. Connection credentials remain in the encrypted
 * secret tables and are purpose-scoped so they can never be advertised as
 * agent-substitutable values. Integration definitions are immutable,
 * project-scoped revisions which are pinned to a run at approval. The action
 * ledger records external-action intent before execution so potentially
 * state-changing work is never silently replayed after a worker interruption.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE test_environment_profiles
      ALTER COLUMN initial_url DROP NOT NULL,
      ALTER COLUMN allowed_origin DROP NOT NULL,
      ADD COLUMN IF NOT EXISTS api_config_json jsonb,
      ADD COLUMN IF NOT EXISTS db_config_json jsonb;

    ALTER TABLE test_environment_profiles
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_ui_target;
    ALTER TABLE test_environment_profiles
      ADD CONSTRAINT chk_test_environment_profiles_ui_target
      CHECK (
        (initial_url IS NULL AND allowed_origin IS NULL)
        OR (initial_url IS NOT NULL AND initial_url <> ''
          AND allowed_origin IS NOT NULL AND allowed_origin <> '')
      ) NOT VALID;
    ALTER TABLE test_environment_profiles
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_api_config_object;
    ALTER TABLE test_environment_profiles
      ADD CONSTRAINT chk_test_environment_profiles_api_config_object
      CHECK (api_config_json IS NULL OR jsonb_typeof(api_config_json) = 'object') NOT VALID;
    ALTER TABLE test_environment_profiles
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_db_config_object;
    ALTER TABLE test_environment_profiles
      ADD CONSTRAINT chk_test_environment_profiles_db_config_object
      CHECK (db_config_json IS NULL OR jsonb_typeof(db_config_json) = 'object') NOT VALID;
    ALTER TABLE test_environment_profiles
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_has_target;
    ALTER TABLE test_environment_profiles
      ADD CONSTRAINT chk_test_environment_profiles_has_target
      CHECK (initial_url IS NOT NULL OR api_config_json IS NOT NULL OR db_config_json IS NOT NULL) NOT VALID;

    ALTER TABLE test_environment_secrets
      ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'agent_value';
    ALTER TABLE test_execution_run_secrets
      ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'agent_value';
    ALTER TABLE test_execution_runs
      ADD COLUMN IF NOT EXISTS capability_snapshot_frozen_at text;
    UPDATE test_execution_runs
      SET capability_snapshot_frozen_at = COALESCE(capability_snapshot_frozen_at, updated_at);

    ALTER TABLE test_environment_secrets
      DROP CONSTRAINT IF EXISTS test_environment_secrets_secret_name_check;
    ALTER TABLE test_environment_secrets
      DROP CONSTRAINT IF EXISTS chk_test_environment_secrets_purpose;
    ALTER TABLE test_environment_secrets
      ADD CONSTRAINT chk_test_environment_secrets_purpose
      CHECK (
        (purpose = 'agent_value' AND secret_name ~ '^[A-Z][A-Z0-9_]{0,63}$')
        OR (purpose = 'api_auth' AND secret_name IN (
          'api.bearer_token', 'api.api_key', 'api.basic_password', 'api.oauth_client_secret'
        ))
        OR (purpose = 'db_connection' AND secret_name = 'db.password')
      ) NOT VALID;

    ALTER TABLE test_execution_run_secrets
      DROP CONSTRAINT IF EXISTS test_execution_run_secrets_secret_name_check;
    ALTER TABLE test_execution_run_secrets
      DROP CONSTRAINT IF EXISTS chk_test_execution_run_secrets_purpose;
    ALTER TABLE test_execution_run_secrets
      ADD CONSTRAINT chk_test_execution_run_secrets_purpose
      CHECK (
        (purpose = 'agent_value' AND secret_name ~ '^[A-Z][A-Z0-9_]{0,63}$')
        OR (purpose = 'api_auth' AND secret_name IN (
          'api.bearer_token', 'api.api_key', 'api.basic_password', 'api.oauth_client_secret'
        ))
        OR (purpose = 'db_connection' AND secret_name = 'db.password')
      ) NOT VALID;

    CREATE TABLE IF NOT EXISTS test_api_contract_revisions (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      stable_key text NOT NULL CHECK (stable_key ~ '^[a-z][a-z0-9_.-]{0,119}$'),
      display_name text NOT NULL CHECK (display_name <> ''),
      revision integer NOT NULL CHECK (revision > 0),
      source_kind text NOT NULL CHECK (source_kind IN ('upload', 'same_origin_url')),
      source_url text,
      content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
      normalized_spec_json jsonb NOT NULL,
      operation_count integer NOT NULL CHECK (operation_count BETWEEN 0 AND 500),
      created_by text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT chk_test_api_contract_revisions_spec_object
        CHECK (jsonb_typeof(normalized_spec_json) = 'object'),
      CONSTRAINT chk_test_api_contract_revisions_source_url
        CHECK (
          (source_kind = 'upload' AND source_url IS NULL)
          OR (source_kind = 'same_origin_url' AND source_url IS NOT NULL AND source_url <> '')
        ),
      CONSTRAINT fk_test_api_contract_revisions_project_scope
        FOREIGN KEY (project_id, workspace_id, azure_project_id)
        REFERENCES projects (id, workspace_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_api_contract_revisions_scope_identity
        UNIQUE (id, workspace_id, project_id, azure_project_id),
      CONSTRAINT uq_test_api_contract_revisions_revision
        UNIQUE (workspace_id, project_id, azure_project_id, stable_key, revision)
    );

    CREATE TABLE IF NOT EXISTS test_integration_operation_revisions (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      stable_key text NOT NULL CHECK (stable_key ~ '^[a-z][a-z0-9_.-]{0,119}$'),
      display_name text NOT NULL CHECK (display_name <> ''),
      revision integer NOT NULL CHECK (revision > 0),
      layer text NOT NULL CHECK (layer IN ('api', 'db')),
      source_kind text NOT NULL CHECK (source_kind IN ('manual', 'openapi')),
      safety_class text NOT NULL CHECK (safety_class IN ('read', 'mutation')),
      database_driver text CHECK (database_driver IN ('postgres', 'sqlserver', 'mysql')),
      api_contract_revision_id text,
      parameter_schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      definition_json jsonb NOT NULL,
      approval_status text NOT NULL DEFAULT 'draft'
        CHECK (approval_status IN ('draft', 'approved', 'archived')),
      approved_by text,
      approved_at text,
      created_by text NOT NULL,
      created_at text NOT NULL,
      CONSTRAINT chk_test_integration_operation_revisions_parameter_schema
        CHECK (jsonb_typeof(parameter_schema_json) = 'object'),
      CONSTRAINT chk_test_integration_operation_revisions_definition
        CHECK (jsonb_typeof(definition_json) = 'object'),
      CONSTRAINT chk_test_integration_operation_revisions_driver
        CHECK (
          (layer = 'api' AND database_driver IS NULL)
          OR (layer = 'db' AND database_driver IS NOT NULL)
        ),
      CONSTRAINT chk_test_integration_operation_revisions_contract
        CHECK (
          (source_kind = 'openapi' AND layer = 'api' AND api_contract_revision_id IS NOT NULL)
          OR (source_kind = 'manual' AND api_contract_revision_id IS NULL)
        ),
      CONSTRAINT chk_test_integration_operation_revisions_approval
        CHECK (
          (approval_status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
          OR (approval_status <> 'approved' AND approved_at IS NULL)
        ),
      CONSTRAINT fk_test_integration_operation_revisions_project_scope
        FOREIGN KEY (project_id, workspace_id, azure_project_id)
        REFERENCES projects (id, workspace_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT fk_test_integration_operation_revisions_contract_scope
        FOREIGN KEY (api_contract_revision_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_api_contract_revisions (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_integration_operation_revisions_scope_identity
        UNIQUE (id, workspace_id, project_id, azure_project_id),
      CONSTRAINT uq_test_integration_operation_revisions_revision
        UNIQUE (workspace_id, project_id, azure_project_id, stable_key, revision)
    );

    CREATE OR REPLACE FUNCTION prevent_test_integration_revision_mutation()
    RETURNS trigger AS $$
    BEGIN
      -- Project deletion is the sole revision-cleanup boundary. The composite
      -- project FK cascades only after the parent row is no longer visible.
      IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM projects p
        WHERE p.id = OLD.project_id
          AND p.workspace_id = OLD.workspace_id
          AND p.azure_project_id = OLD.azure_project_id
      ) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION
        'Test integration revisions are immutable.'
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_test_api_contract_revisions_immutable
      ON test_api_contract_revisions;
    CREATE TRIGGER trg_test_api_contract_revisions_immutable
      BEFORE UPDATE OR DELETE ON test_api_contract_revisions
      FOR EACH ROW EXECUTE FUNCTION prevent_test_integration_revision_mutation();

    DROP TRIGGER IF EXISTS trg_test_integration_operation_revisions_immutable
      ON test_integration_operation_revisions;
    CREATE TRIGGER trg_test_integration_operation_revisions_immutable
      BEFORE UPDATE OR DELETE ON test_integration_operation_revisions
      FOR EACH ROW EXECUTE FUNCTION prevent_test_integration_revision_mutation();

    CREATE INDEX IF NOT EXISTS idx_test_integration_operation_revisions_lookup
      ON test_integration_operation_revisions (
        workspace_id, project_id, azure_project_id, layer, approval_status, stable_key, revision DESC
      );

    CREATE TABLE IF NOT EXISTS test_execution_run_capabilities (
      id text PRIMARY KEY,
      run_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      capability_kind text NOT NULL CHECK (capability_kind IN ('operation', 'api_contract')),
      operation_revision_id text,
      api_contract_revision_id text,
      created_at text NOT NULL,
      CONSTRAINT chk_test_execution_run_capabilities_target
        CHECK (
          (capability_kind = 'operation' AND operation_revision_id IS NOT NULL AND api_contract_revision_id IS NULL)
          OR (capability_kind = 'api_contract' AND operation_revision_id IS NULL AND api_contract_revision_id IS NOT NULL)
        ),
      CONSTRAINT fk_test_execution_run_capabilities_run_scope
        FOREIGN KEY (run_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_execution_runs (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT fk_test_execution_run_capabilities_operation_scope
        FOREIGN KEY (operation_revision_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_integration_operation_revisions (id, workspace_id, project_id, azure_project_id)
        ON DELETE RESTRICT,
      CONSTRAINT fk_test_execution_run_capabilities_contract_scope
        FOREIGN KEY (api_contract_revision_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_api_contract_revisions (id, workspace_id, project_id, azure_project_id)
        ON DELETE RESTRICT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_test_execution_run_capabilities_operation
      ON test_execution_run_capabilities (run_id, operation_revision_id)
      WHERE operation_revision_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_test_execution_run_capabilities_contract
      ON test_execution_run_capabilities (run_id, api_contract_revision_id)
      WHERE api_contract_revision_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION enforce_test_execution_run_capability_snapshot()
    RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        IF EXISTS (
          SELECT 1 FROM test_execution_runs r
          WHERE r.id = NEW.run_id
            AND r.workspace_id = NEW.workspace_id
            AND r.project_id = NEW.project_id
            AND r.azure_project_id = NEW.azure_project_id
            AND r.status = 'queued'
            AND r.capability_snapshot_frozen_at IS NULL
        ) THEN
          RETURN NEW;
        END IF;
      ELSIF TG_OP = 'DELETE' THEN
        -- A parent-run CASCADE is the only permitted pin deletion.
        IF NOT EXISTS (
          SELECT 1 FROM test_execution_runs r
          WHERE r.id = OLD.run_id
            AND r.workspace_id = OLD.workspace_id
            AND r.project_id = OLD.project_id
            AND r.azure_project_id = OLD.azure_project_id
        ) THEN
          RETURN OLD;
        END IF;
      END IF;
      RAISE EXCEPTION
        'Test execution run capabilities are immutable after approval.'
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_test_execution_run_capabilities_immutable
      ON test_execution_run_capabilities;
    CREATE TRIGGER trg_test_execution_run_capabilities_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON test_execution_run_capabilities
      FOR EACH ROW EXECUTE FUNCTION enforce_test_execution_run_capability_snapshot();

    CREATE OR REPLACE FUNCTION prevent_test_execution_capability_snapshot_thaw()
    RETURNS trigger AS $$
    BEGIN
      IF OLD.capability_snapshot_frozen_at IS NOT NULL
        AND NEW.capability_snapshot_frozen_at IS DISTINCT FROM OLD.capability_snapshot_frozen_at THEN
        RAISE EXCEPTION
          'Test execution capability snapshots cannot be reopened.'
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_test_execution_runs_capability_snapshot_frozen
      ON test_execution_runs;
    CREATE TRIGGER trg_test_execution_runs_capability_snapshot_frozen
      BEFORE UPDATE OF capability_snapshot_frozen_at ON test_execution_runs
      FOR EACH ROW EXECUTE FUNCTION prevent_test_execution_capability_snapshot_thaw();

    CREATE TABLE IF NOT EXISTS workspace_test_egress_rules (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name text NOT NULL CHECK (name <> ''),
      target_kind text NOT NULL CHECK (target_kind IN ('api', 'database', 'oauth', 'openapi')),
      protocol text NOT NULL CHECK (protocol IN ('http', 'https', 'tcp')),
      host_pattern text NOT NULL CHECK (host_pattern <> ''),
      port_from integer NOT NULL CHECK (port_from BETWEEN 1 AND 65535),
      port_to integer NOT NULL CHECK (port_to BETWEEN 1 AND 65535),
      allow_private_network boolean NOT NULL DEFAULT false,
      enabled boolean NOT NULL DEFAULT true,
      created_by text NOT NULL,
      updated_by text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_workspace_test_egress_rules_port_range CHECK (port_to >= port_from),
      CONSTRAINT uq_workspace_test_egress_rules_name UNIQUE (workspace_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_test_egress_rules_lookup
      ON workspace_test_egress_rules (workspace_id, target_kind, enabled);

    ALTER TABLE test_execution_step_runs
      DROP CONSTRAINT IF EXISTS uq_test_execution_step_runs_chain;
    ALTER TABLE test_execution_step_runs
      ADD CONSTRAINT uq_test_execution_step_runs_chain UNIQUE (id, case_run_id, run_id);

    CREATE TABLE IF NOT EXISTS test_execution_action_runs (
      id text PRIMARY KEY,
      step_run_id text NOT NULL,
      case_run_id text NOT NULL,
      run_id text NOT NULL,
      workspace_id text NOT NULL,
      project_id text NOT NULL,
      azure_project_id text NOT NULL,
      order_index integer NOT NULL CHECK (order_index >= 0),
      layer text NOT NULL CHECK (layer IN ('ui', 'api', 'db')),
      action_type text NOT NULL CHECK (action_type <> ''),
      safety_class text NOT NULL CHECK (safety_class IN ('ui', 'read', 'mutation')),
      owning_job_id text NOT NULL CHECK (owning_job_id <> ''),
      request_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed', 'blocked', 'canceled', 'uncertain')),
      observation_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      error_category text CHECK (error_category IN (
        'assertion', 'blocked_policy', 'blocked_prerequisite', 'infrastructure',
        'timeout', 'canceled', 'uncertain_side_effect'
      )),
      error_message text,
      started_at text NOT NULL,
      finished_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      CONSTRAINT chk_test_execution_action_runs_request_object
        CHECK (jsonb_typeof(request_json) = 'object'),
      CONSTRAINT chk_test_execution_action_runs_observation_object
        CHECK (jsonb_typeof(observation_json) = 'object'),
      CONSTRAINT chk_test_execution_action_runs_terminal_time
        CHECK (
          (status = 'running' AND finished_at IS NULL)
          OR (status <> 'running' AND finished_at IS NOT NULL)
        ),
      CONSTRAINT fk_test_execution_action_runs_step_chain
        FOREIGN KEY (step_run_id, case_run_id, run_id)
        REFERENCES test_execution_step_runs (id, case_run_id, run_id)
        ON DELETE CASCADE,
      CONSTRAINT fk_test_execution_action_runs_run_scope
        FOREIGN KEY (run_id, workspace_id, project_id, azure_project_id)
        REFERENCES test_execution_runs (id, workspace_id, project_id, azure_project_id)
        ON DELETE CASCADE,
      CONSTRAINT uq_test_execution_action_runs_order UNIQUE (step_run_id, order_index)
    );

    CREATE INDEX IF NOT EXISTS idx_test_execution_action_runs_run
      ON test_execution_action_runs (run_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_test_execution_action_runs_running
      ON test_execution_action_runs (run_id, status)
      WHERE status = 'running';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM test_environment_profiles
        WHERE initial_url IS NULL OR allowed_origin IS NULL
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'check_violation',
          MESSAGE = 'Cannot roll back multi-layer test execution while API/DB-only environment profiles exist.';
      END IF;

      IF EXISTS (
        SELECT 1 FROM test_environment_secrets WHERE purpose <> 'agent_value'
        UNION ALL
        SELECT 1 FROM test_execution_run_secrets WHERE purpose <> 'agent_value'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = 'check_violation',
          MESSAGE = 'Cannot roll back multi-layer test execution while scoped API/DB connection secrets exist.';
      END IF;
    END
    $$;

    DROP INDEX IF EXISTS idx_test_execution_action_runs_running;
    DROP INDEX IF EXISTS idx_test_execution_action_runs_run;
    DROP TABLE IF EXISTS test_execution_action_runs;
    ALTER TABLE test_execution_step_runs
      DROP CONSTRAINT IF EXISTS uq_test_execution_step_runs_chain;

    DROP INDEX IF EXISTS idx_workspace_test_egress_rules_lookup;
    DROP TABLE IF EXISTS workspace_test_egress_rules;

    DROP INDEX IF EXISTS uq_test_execution_run_capabilities_contract;
    DROP INDEX IF EXISTS uq_test_execution_run_capabilities_operation;
    DROP TRIGGER IF EXISTS trg_test_execution_run_capabilities_immutable
      ON test_execution_run_capabilities;
    DROP TABLE IF EXISTS test_execution_run_capabilities;
    DROP FUNCTION IF EXISTS enforce_test_execution_run_capability_snapshot();
    DROP TRIGGER IF EXISTS trg_test_execution_runs_capability_snapshot_frozen
      ON test_execution_runs;
    DROP FUNCTION IF EXISTS prevent_test_execution_capability_snapshot_thaw();
    ALTER TABLE test_execution_runs
      DROP COLUMN IF EXISTS capability_snapshot_frozen_at;

    DROP INDEX IF EXISTS idx_test_integration_operation_revisions_lookup;
    DROP TRIGGER IF EXISTS trg_test_integration_operation_revisions_immutable
      ON test_integration_operation_revisions;
    DROP TRIGGER IF EXISTS trg_test_api_contract_revisions_immutable
      ON test_api_contract_revisions;
    DROP FUNCTION IF EXISTS prevent_test_integration_revision_mutation();
    DROP TABLE IF EXISTS test_integration_operation_revisions;
    DROP TABLE IF EXISTS test_api_contract_revisions;

    ALTER TABLE test_execution_run_secrets
      DROP CONSTRAINT IF EXISTS chk_test_execution_run_secrets_purpose,
      DROP COLUMN IF EXISTS purpose;
    ALTER TABLE test_execution_run_secrets
      ADD CONSTRAINT test_execution_run_secrets_secret_name_check
      CHECK (secret_name ~ '^[A-Z][A-Z0-9_]{0,63}$') NOT VALID;
    ALTER TABLE test_environment_secrets
      DROP CONSTRAINT IF EXISTS chk_test_environment_secrets_purpose,
      DROP COLUMN IF EXISTS purpose;
    ALTER TABLE test_environment_secrets
      ADD CONSTRAINT test_environment_secrets_secret_name_check
      CHECK (secret_name ~ '^[A-Z][A-Z0-9_]{0,63}$') NOT VALID;

    ALTER TABLE test_environment_profiles
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_has_target,
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_db_config_object,
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_api_config_object,
      DROP CONSTRAINT IF EXISTS chk_test_environment_profiles_ui_target,
      DROP COLUMN IF EXISTS db_config_json,
      DROP COLUMN IF EXISTS api_config_json;
    ALTER TABLE test_environment_profiles
      ALTER COLUMN initial_url SET NOT NULL,
      ALTER COLUMN allowed_origin SET NOT NULL;
  `);
};
