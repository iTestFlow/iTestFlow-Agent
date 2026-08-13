/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => pgm.sql(`
  CREATE TABLE jira_artifact_backend_configs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    project_id text NOT NULL,
    backend_type text NOT NULL CHECK (backend_type IN ('plain_jira', 'xray_cloud', 'zephyr_scale')),
    config_json text NOT NULL,
    encrypted_secret text,
    secret_iv text,
    secret_tag text,
    key_version integer,
    region text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reauthorization_required', 'disabled')),
    created_at text NOT NULL,
    updated_at text NOT NULL,
    UNIQUE (workspace_id, project_id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
  );
  CREATE TABLE jira_artifact_links (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    project_id text NOT NULL,
    backend_type text NOT NULL CHECK (backend_type IN ('plain_jira', 'xray_cloud', 'zephyr_scale')),
    local_artifact_type text NOT NULL,
    local_artifact_id text NOT NULL,
    remote_artifact_id text,
    remote_url text,
    status text NOT NULL DEFAULT 'publishing' CHECK (status IN ('publishing', 'active', 'missing_remote', 'error')),
    created_at text NOT NULL,
    updated_at text NOT NULL,
    UNIQUE (workspace_id, project_id, local_artifact_type, local_artifact_id),
    UNIQUE (workspace_id, project_id, backend_type, remote_artifact_id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
  );
`);

exports.down = (pgm) => pgm.sql(`
  DROP TABLE IF EXISTS jira_artifact_links;
  DROP TABLE IF EXISTS jira_artifact_backend_configs;
`);
