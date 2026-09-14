import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const ddl = () => fs.readFileSync(path.join(process.cwd(), "migrations/1710000047000_jira_pat_credentials.js"), "utf8");

it("drops the OAuth/webhook era and rebuilds jira_connections for per-user API tokens", () => {
  const sql = ddl();
  // Destructive drops (pre-release; secrets/events unrecoverable).
  expect(sql).toContain("DROP TABLE IF EXISTS jira_oauth_selections");
  expect(sql).toContain("DROP TABLE IF EXISTS jira_oauth_states");
  expect(sql).toContain("DROP TABLE IF EXISTS jira_webhook_events");
  expect(sql).toContain("DROP TABLE IF EXISTS jira_webhooks");
  expect(sql).toContain("DELETE FROM jobs WHERE job_type = 'jira_webhook_reconcile'");
  // Rebuilt PAT-shaped jira_connections.
  expect(sql).toContain("DROP TABLE IF EXISTS jira_connections");
  expect(sql).toContain("email text NOT NULL");
  expect(sql).toContain("CHECK (token_kind IN ('scoped', 'classic'))");
  expect(sql).toContain("CHECK (status IN ('active', 'invalid', 'revoked'))");
  expect(sql).toContain("last_validated_at text");
  expect(sql).toContain("UNIQUE (workspace_id, user_id)");
  // Secrets are nullable so revocation can genuinely clear them, but an active
  // connection must carry the complete encrypted token set.
  expect(sql).toMatch(/CHECK \(\s*status <> 'active'\s*OR \(\s*encrypted_api_token IS NOT NULL/);
  expect(sql).toContain("CREATE UNIQUE INDEX idx_jira_connections_sync_principal");
  expect(sql).toContain("WHERE is_sync_principal = true AND status = 'active'");
  // Typed job failure codes ride along for the credential-health pipeline.
  expect(sql).toContain("ALTER TABLE jobs ADD COLUMN error_code text");
});

it("never touches the preserved sync tables or their identity indexes", () => {
  const sql = ddl();
  for (const preserved of [
    "jira_sync_mappings", "jira_sync_field_states", "jira_sync_operations",
    "jira_project_sync_configs", "jira_artifact_backend_configs", "jira_artifact_links",
    "external_identities",
  ]) {
    expect(sql).not.toContain(`DROP TABLE IF EXISTS ${preserved}`);
    expect(sql).not.toContain(`DROP TABLE ${preserved}`);
  }
  expect(sql).not.toContain("idx_projects_workspace_identity");
  expect(sql).not.toContain("idx_workspaces_provider_site");
});

it("recreates every dropped structure empty on down so the reset down-chain stays runnable", () => {
  const sql = ddl();
  const down = sql.slice(sql.indexOf("exports.down"));
  expect(down).toContain("CREATE TABLE jira_oauth_states");
  expect(down).toContain("CREATE TABLE jira_oauth_selections");
  expect(down).toContain("CREATE TABLE jira_webhooks");
  expect(down).toContain("CREATE TABLE jira_webhook_events");
  expect(down).toContain("encrypted_refresh_token text NOT NULL");
  expect(down).toContain("ALTER TABLE jobs DROP COLUMN IF EXISTS error_code");
});
