import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const ddl = () => fs.readFileSync(path.join(process.cwd(), "migrations/1710000048000_jira_oauth_credentials.js"), "utf8");
// Scope up()-assertions to the up() block: a statement moved into down() or
// into the header comment must not satisfy an up() pin.
const upSql = () => {
  const sql = ddl();
  return sql.slice(sql.indexOf("exports.up"), sql.indexOf("exports.down"));
};
const downSql = () => {
  const sql = ddl();
  return sql.slice(sql.indexOf("exports.down"));
};

const NAMED_CONSTRAINTS = [
  "chk_jira_connections_credential_kind",
  "chk_jira_connections_status",
  "chk_jira_connections_reauth_kind",
  "chk_jira_connections_invalid_kind",
  "chk_jira_connections_active_secrets",
  "chk_jira_connections_kind_hygiene",
] as const;

it("extends jira_connections additively for dual credential kinds — never a rebuild", () => {
  const up = upSql();
  // Additive discriminator: every existing row stays valid as an API-token row.
  expect(up).toContain("ADD COLUMN credential_kind text NOT NULL DEFAULT 'api_token'");
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
    expect(up).toContain(`ADD COLUMN ${column}`);
  }
  // OAuth rows carry no token kind; NULL passes the retained 47000 kind CHECK.
  expect(up).toContain("ALTER COLUMN token_kind DROP NOT NULL");
  expect(up).not.toContain("DROP CONSTRAINT jira_connections_token_kind_check");
  // The two 47000 CHECKs being replaced, dropped by their auto-generated names
  // (confirmed against a live Postgres 16 replay of the 47000 table DDL).
  expect(up).toContain("DROP CONSTRAINT jira_connections_status_check");
  expect(up).toContain("DROP CONSTRAINT jira_connections_check");
  // Replacements are named, so future migrations never guess auto-names again.
  expect(up).toContain("ADD CONSTRAINT chk_jira_connections_credential_kind CHECK (credential_kind IN ('api_token', 'oauth'))");
  expect(up).toContain("ADD CONSTRAINT chk_jira_connections_status CHECK (status IN ('active', 'invalid', 'reauthorization_required', 'revoked'))");
  // The failure states are kind-exclusive: reauthorization_required is the
  // OAuth analogue of invalid, and the tri-state token-replacement UX never
  // speaks to an OAuth row.
  expect(up).toContain("ADD CONSTRAINT chk_jira_connections_reauth_kind CHECK (status <> 'reauthorization_required' OR credential_kind = 'oauth')");
  expect(up).toContain("ADD CONSTRAINT chk_jira_connections_invalid_kind CHECK (status <> 'invalid' OR credential_kind = 'api_token')");
  // An active row carries the complete secret set for its own kind.
  expect(up).toMatch(/ADD CONSTRAINT chk_jira_connections_active_secrets CHECK \(\s*status <> 'active'\s*OR \(\s*credential_kind = 'api_token'\s*AND token_kind IS NOT NULL\s*AND encrypted_api_token IS NOT NULL/);
  expect(up).toMatch(/credential_kind = 'oauth'\s*AND encrypted_access_token IS NOT NULL/);
  expect(up).toMatch(/AND encrypted_refresh_token IS NOT NULL/);
  expect(up).toMatch(/AND access_expires_at IS NOT NULL/);
  // Kind hygiene: an api_token row always carries its token_kind (restores the
  // 47000 column invariant, and keeps down()'s SET NOT NULL safe on rows of
  // any status), and a row never carries the other kind's secrets.
  expect(up).toMatch(/ADD CONSTRAINT chk_jira_connections_kind_hygiene CHECK \(\s*\(\s*credential_kind = 'api_token'\s*AND token_kind IS NOT NULL\s*AND encrypted_access_token IS NULL/);
  expect(up).toMatch(/credential_kind = 'oauth'\s*AND token_kind IS NULL\s*AND encrypted_api_token IS NULL/);
  // Additive means additive: the table, its rows, and the principal index survive.
  expect(up).not.toContain("DROP TABLE IF EXISTS jira_connections");
  expect(up).not.toContain("DROP TABLE jira_connections");
  expect(up).not.toMatch(/DELETE FROM jira_connections|TRUNCATE|UPDATE jira_connections/);
  expect(ddl()).not.toContain("idx_jira_connections_sync_principal");
});

it("recreates jira_oauth_states workspace-bound and never the selections escrow", () => {
  const up = upSql();
  expect(up).toContain("CREATE TABLE jira_oauth_states");
  expect(up).toContain("state_hash text NOT NULL UNIQUE");
  expect(up).toContain("browser_binding_hash text NOT NULL");
  expect(up).toContain("return_to text NOT NULL");
  // Site-before-OAuth: the state row is bound to the operator-configured
  // workspace and carries its pinned cloud ID (nullable — seeded workspaces
  // adopt their pin on first login).
  expect(up).toContain("selected_workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE");
  expect(up).toContain("selected_site_url text NOT NULL");
  expect(up).toContain("selected_cloud_id text");
  expect(up).toContain("CREATE INDEX idx_jira_oauth_states_expiry ON jira_oauth_states(expires_at)");
  // The post-callback multi-site escrow stays dead: never created, never touched.
  expect(ddl()).not.toContain("CREATE TABLE jira_oauth_selections");
  expect(ddl()).not.toContain("DROP TABLE IF EXISTS jira_oauth_selections");
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
  const down = downSql();
  // OAuth rows cannot survive losing their columns; API-token rows must.
  expect(down).toContain("DELETE FROM jira_connections WHERE credential_kind = 'oauth'");
  expect(down).toContain("DROP TABLE IF EXISTS jira_oauth_states");
  // IF EXISTS keeps the reset chain runnable on a dev database wedged between
  // migration-file revisions — the exact hazard the burned 1710000046000 left
  // behind (see fix-migration-history).
  for (const constraint of NAMED_CONSTRAINTS) {
    expect(down).toContain(`DROP CONSTRAINT IF EXISTS ${constraint}`);
  }
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
