/* eslint-disable camelcase */

/**
 * Phase 1b — identity & workspace foundation.
 *
 * Adds users, sessions, workspaces, workspace_members, and a nullable
 * workspaces FK on the existing projects table. These are the primitives for
 * server-side sessions and workspace-scoped authorization. No existing feature
 * is wired to them yet (enforcement lands after Phase 2 credentials — ADR-8).
 *
 * Conventions match the rest of the schema: text primary keys (app-generated
 * ids) and ISO-8601 timestamps stored as text.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE users (
      id text PRIMARY KEY,
      display_name text,
      email_or_unique_name text UNIQUE,
      azure_identity_id text UNIQUE,
      azure_descriptor text,
      status text NOT NULL DEFAULT 'active',
      created_at text NOT NULL,
      last_login_at text
    );

    CREATE TABLE workspaces (
      id text PRIMARY KEY,
      name text NOT NULL,
      azure_org_name text NOT NULL,
      azure_org_url text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'active',
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE workspace_members (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      status text NOT NULL DEFAULT 'active',
      created_at text NOT NULL,
      updated_at text NOT NULL,
      UNIQUE (workspace_id, user_id)
    );

    CREATE TABLE sessions (
      id text PRIMARY KEY,
      user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hashed_token text NOT NULL UNIQUE,
      ip text,
      user_agent text,
      created_at text NOT NULL,
      last_seen_at text NOT NULL,
      expires_at text NOT NULL,
      revoked_at text
    );

    ALTER TABLE projects ADD COLUMN workspace_id text REFERENCES workspaces(id);

    CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);
    CREATE INDEX idx_workspace_members_workspace ON workspace_members(workspace_id, status);
    CREATE INDEX idx_sessions_user ON sessions(user_id);
    CREATE INDEX idx_projects_workspace ON projects(workspace_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_projects_workspace;
    ALTER TABLE projects DROP COLUMN IF EXISTS workspace_id;
    DROP TABLE IF EXISTS sessions CASCADE;
    DROP TABLE IF EXISTS workspace_members CASCADE;
    DROP TABLE IF EXISTS workspaces CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
  `);
};
