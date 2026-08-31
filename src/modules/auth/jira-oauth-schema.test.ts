import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const ddl = () => fs.readFileSync(path.join(process.cwd(), "migrations/1710000048000_jira_oauth_credentials.js"), "utf8");

it("extends jira_connections additively for dual credential kinds — never a rebuild", () => {
  const sql = ddl();
  // Additive discriminator: every existing row stays valid as an API-token row.
  expect(sql).toContain("ADD COLUMN credential_kind text NOT NULL DEFAULT 'api_token'");
  // OAuth secret pair + expiry ride alongside the token columns, nullable so
  // revocation can genuinely clear them.
  for (const column of [
    "encrypted_access_token text",
    "access_token_iv text",
    "access_token_tag text",
    "encrypted_refresh_token text",
    "refresh_token_iv text",
    "refresh_token_tag text",
    "access_expires_at text",
  ]) {
    expect(sql).toContain(`ADD COLUMN ${column}`);
  }
  // OAuth rows carry no token kind; NULL passes the retained 47000 kind CHECK.
  expect(sql).toContain("ALTER COLUMN token_kind DROP NOT NULL");
  expect(sql).not.toContain("DROP CONSTRAINT jira_connections_token_kind_check");
  // The two 47000 CHECKs being replaced, dropped by their auto-generated names
  // (confirmed against a live Postgres 16 replay of the 47000 table DDL).
  expect(sql).toContain("DROP CONSTRAINT jira_connections_status_check");
  expect(sql).toContain("DROP CONSTRAINT jira_connections_check");
  // Replacements are named, so future migrations never guess auto-names again.
  expect(sql).toContain("ADD CONSTRAINT chk_jira_connections_credential_kind CHECK (credential_kind IN ('api_token', 'oauth'))");
  expect(sql).toContain("ADD CONSTRAINT chk_jira_connections_status CHECK (status IN ('active', 'invalid', 'reauthorization_required', 'revoked'))");
  // reauthorization_required is an OAuth-only lifecycle state.
  expect(sql).toContain("ADD CONSTRAINT chk_jira_connections_reauth_kind CHECK (status <> 'reauthorization_required' OR credential_kind = 'oauth')");
  // An active row carries the complete secret set for its own kind.
  expect(sql).toMatch(/ADD CONSTRAINT chk_jira_connections_active_secrets CHECK \(\s*status <> 'active'\s*OR \(\s*credential_kind = 'api_token'\s*AND token_kind IS NOT NULL\s*AND encrypted_api_token IS NOT NULL/);
  expect(sql).toMatch(/credential_kind = 'oauth'\s*AND encrypted_access_token IS NOT NULL/);
  expect(sql).toMatch(/AND encrypted_refresh_token IS NOT NULL/);
  expect(sql).toMatch(/AND access_expires_at IS NOT NULL/);
  // Kind hygiene: a row never carries the other kind's secrets.
  expect(sql).toMatch(/ADD CONSTRAINT chk_jira_connections_kind_hygiene CHECK \(\s*\(\s*credential_kind = 'api_token'\s*AND encrypted_access_token IS NULL/);
  expect(sql).toMatch(/credential_kind = 'oauth'\s*AND token_kind IS NULL\s*AND encrypted_api_token IS NULL/);
  // Additive means additive: the table, its rows, and the principal index survive.
  expect(sql).not.toContain("DROP TABLE IF EXISTS jira_connections");
  expect(sql).not.toContain("DROP TABLE jira_connections");
  expect(sql).not.toContain("idx_jira_connections_sync_principal");
});

it("recreates jira_oauth_states workspace-bound and never the selections escrow", () => {
  const sql = ddl();
  expect(sql).toContain("CREATE TABLE jira_oauth_states");
  expect(sql).toContain("state_hash text NOT NULL UNIQUE");
  expect(sql).toContain("browser_binding_hash text NOT NULL");
  expect(sql).toContain("return_to text NOT NULL");
  // Site-before-OAuth: the state row is bound to the operator-configured
  // workspace and carries its pinned cloud ID (nullable — seeded workspaces
  // adopt their pin on first login).
  expect(sql).toContain("selected_workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE");
  expect(sql).toContain("selected_site_url text NOT NULL");
  expect(sql).toContain("selected_cloud_id text");
  expect(sql).toContain("CREATE INDEX idx_jira_oauth_states_expiry ON jira_oauth_states(expires_at)");
  // The post-callback multi-site escrow stays dead: never created, never touched.
  expect(sql).not.toContain("CREATE TABLE jira_oauth_selections");
  expect(sql).not.toContain("DROP TABLE IF EXISTS jira_oauth_selections");
});

it("never touches the preserved sync tables or their identity indexes", () => {
  const sql = ddl();
  for (const preserved of [
    "jira_sync_mappings", "jira_sync_field_states", "jira_sync_operations",
    "jira_project_sync_configs", "jira_artifact_backend_configs", "jira_artifact_links",
    "external_identities",
  ]) {
    expect(sql).not.toContain(preserved);
  }
  expect(sql).not.toContain("idx_projects_workspace_identity");
  expect(sql).not.toContain("idx_workspaces_provider_site");
});

it("down() removes only what up() added and restores the 47000 constraint names", () => {
  const sql = ddl();
  const down = sql.slice(sql.indexOf("exports.down"));
  // OAuth rows cannot survive losing their columns; API-token rows must.
  expect(down).toContain("DELETE FROM jira_connections WHERE credential_kind = 'oauth'");
  expect(down).toContain("DROP TABLE IF EXISTS jira_oauth_states");
  for (const column of [
    "credential_kind",
    "encrypted_access_token", "access_token_iv", "access_token_tag",
    "encrypted_refresh_token", "refresh_token_iv", "refresh_token_tag",
    "access_expires_at",
  ]) {
    expect(down).toContain(`DROP COLUMN ${column}`);
  }
  expect(down).toContain("ALTER COLUMN token_kind SET NOT NULL");
  // Restore the exact auto-generated names 47000 left behind, so this
  // migration's own up() (which drops by those names) stays re-runnable.
  expect(down).toContain("ADD CONSTRAINT jira_connections_status_check CHECK (status IN ('active', 'invalid', 'revoked'))");
  expect(down).toMatch(/ADD CONSTRAINT jira_connections_check CHECK \(\s*status <> 'active'\s*OR \(\s*encrypted_api_token IS NOT NULL/);
});
