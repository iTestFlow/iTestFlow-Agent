/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX idx_projects_workspace_identity ON projects(workspace_id, id);
    CREATE TABLE jira_webhooks (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id text NOT NULL,
      cloud_id text NOT NULL,
      webhook_id text,
      expires_at text,
      status text NOT NULL DEFAULT 'registering' CHECK (status IN ('registering', 'active', 'renewal_required', 'registration_error', 'disabled')),
      last_error_code text,
      callback_key_hash text NOT NULL UNIQUE,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (cloud_id, webhook_id),
      UNIQUE (workspace_id, project_id),
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
    );
    CREATE INDEX idx_jira_webhooks_renewal ON jira_webhooks(status, expires_at);

    CREATE TABLE jira_webhook_events (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id text NOT NULL,
      cloud_id text NOT NULL,
      delivery_id text NOT NULL,
      event_type text NOT NULL,
      issue_id text,
      payload_hash text NOT NULL,
      payload_json text NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      retry_count integer NOT NULL DEFAULT 0,
      received_at text NOT NULL,
      processed_at text,
      error_code text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (cloud_id, delivery_id),
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
    );
    CREATE INDEX idx_jira_webhook_events_pending ON jira_webhook_events(status, received_at);

    CREATE TABLE jira_sync_mappings (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      project_id text NOT NULL,
      jira_issue_id text NOT NULL,
      jira_issue_key text NOT NULL,
      local_entity_type text NOT NULL,
      local_entity_id text NOT NULL,
      direction text NOT NULL CHECK (direction IN ('jira_to_itestflow', 'itestflow_to_jira', 'two_way')),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'syncing', 'conflict', 'paused', 'error')),
      last_remote_updated_at text,
      last_synced_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (workspace_id, project_id, jira_issue_id),
      UNIQUE (workspace_id, project_id, local_entity_type, local_entity_id),
      FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
    );

    CREATE TABLE jira_sync_field_states (
      id text PRIMARY KEY,
      mapping_id text NOT NULL REFERENCES jira_sync_mappings(id) ON DELETE CASCADE,
      field_name text NOT NULL,
      baseline_json text,
      local_json text,
      remote_json text,
      status text NOT NULL DEFAULT 'in_sync' CHECK (status IN ('in_sync', 'pending', 'conflict', 'error')),
      resolution text CHECK (resolution IS NULL OR resolution IN ('use_local', 'use_remote')),
      resolved_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
      resolved_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (mapping_id, field_name)
    );
    CREATE INDEX idx_jira_sync_conflicts ON jira_sync_field_states(status, updated_at DESC);

    CREATE TABLE jira_sync_operations (
      id text PRIMARY KEY,
      mapping_id text NOT NULL REFERENCES jira_sync_mappings(id) ON DELETE CASCADE,
      field_name text NOT NULL,
      operation text NOT NULL CHECK (operation IN ('pull', 'push')),
      target_json text,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
      attempts integer NOT NULL DEFAULT 0,
      error_code text,
      run_after text NOT NULL,
      processing_started_at text,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      completed_at text
    );
    CREATE UNIQUE INDEX idx_jira_sync_operations_active
      ON jira_sync_operations(mapping_id, field_name) WHERE status IN ('pending', 'processing');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS jira_sync_operations;
    DROP TABLE IF EXISTS jira_sync_field_states;
    DROP TABLE IF EXISTS jira_sync_mappings;
    DROP TABLE IF EXISTS jira_webhook_events;
    DROP TABLE IF EXISTS jira_webhooks;
    DROP INDEX IF EXISTS idx_projects_workspace_identity;
  `);
};
