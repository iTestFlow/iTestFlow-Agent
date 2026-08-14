/* eslint-disable camelcase */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE projects ADD COLUMN provider_project_id text;
    ALTER TABLE projects ADD COLUMN provider_project_key text;
    ALTER TABLE projects ADD COLUMN provider_project_name text;
    UPDATE projects
    SET provider_project_id = azure_project_id,
        provider_project_name = azure_project_name
    WHERE provider_id = 'azure-devops';
    CREATE UNIQUE INDEX idx_projects_provider_project
      ON projects(workspace_id, provider_id, provider_project_id)
      WHERE workspace_id IS NOT NULL AND provider_project_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_projects_provider_project;
    ALTER TABLE projects DROP COLUMN IF EXISTS provider_project_name;
    ALTER TABLE projects DROP COLUMN IF EXISTS provider_project_key;
    ALTER TABLE projects DROP COLUMN IF EXISTS provider_project_id;
  `);
};
