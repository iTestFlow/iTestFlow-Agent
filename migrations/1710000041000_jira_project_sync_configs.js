/* eslint-disable camelcase */
exports.shorthands = undefined;

exports.up = (pgm) => pgm.sql(`
  CREATE TABLE jira_project_sync_configs (
    id text PRIMARY KEY,
    workspace_id text NOT NULL,
    project_id text NOT NULL,
    direction text NOT NULL CHECK (direction IN ('jira_to_itestflow', 'itestflow_to_jira', 'two_way')),
    field_mapping_json text NOT NULL,
    status_mapping_json text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at text NOT NULL,
    updated_at text NOT NULL,
    UNIQUE (workspace_id, project_id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE
  );
`);

exports.down = (pgm) => pgm.sql(`
  DROP TABLE IF EXISTS jira_project_sync_configs;
`);
