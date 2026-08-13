import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const migration = require("../../../migrations/1710000037000_jira_oauth_identity.js") as {
  up: (pgm: { sql: (statement: string) => void }) => void;
  down: (pgm: { sql: (statement: string) => void }) => void;
};

describe("Jira OAuth identity migration", () => {
  it("adds provider-neutral identity, workspace site fields, one-time state, and encrypted rotating connections", () => {
    const sql = vi.fn();

    migration.up({ sql });

    const ddl = sql.mock.calls.map(([statement]) => statement).join("\n");
    expect(ddl).toContain("CREATE TABLE external_identities");
    expect(ddl).toContain("UNIQUE (provider_id, provider_subject)");
    expect(ddl).toContain("CREATE UNIQUE INDEX idx_users_email_ci");
    expect(ddl).toContain("ADD COLUMN provider_site_id");
    expect(ddl).toContain("DROP NOT NULL");
    expect(ddl).toContain("CREATE TABLE jira_oauth_states");
    expect(ddl).toContain("state_hash text NOT NULL UNIQUE");
    expect(ddl).toContain("browser_binding_hash text NOT NULL");
    expect(ddl).toContain("CREATE TABLE jira_oauth_selections");
    expect(ddl).toContain("CREATE TABLE jira_connections");
    expect(ddl).toContain("encrypted_refresh_token text NOT NULL");
    expect(ddl).toContain("access_expires_at text NOT NULL");
    expect(ddl).toContain("UNIQUE (workspace_id, user_id)");
    expect(ddl).toContain("CREATE UNIQUE INDEX idx_jira_connections_sync_principal");
    expect(ddl).toContain("WHERE is_sync_principal = true AND status = 'active'");
  });

  it("drops dependent Jira data before provider-neutral workspace columns on rollback", () => {
    const sql = vi.fn();
    migration.down({ sql });
    const ddl = String(sql.mock.calls[0][0]);
    expect(ddl.indexOf("DROP TABLE IF EXISTS jira_connections")).toBeLessThan(
      ddl.indexOf("ALTER TABLE workspaces DROP COLUMN IF EXISTS provider_site_url"),
    );
    expect(ddl).toContain("DROP TABLE IF EXISTS external_identities");
    expect(ddl).toContain("ALTER TABLE workspaces ALTER COLUMN azure_org_url SET NOT NULL");
  });
});
