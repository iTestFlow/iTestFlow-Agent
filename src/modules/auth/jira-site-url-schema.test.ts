import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const migration = require("../../../migrations/1710000045000_workspace_jira_site_url_unique.js") as {
  up: (pgm: { sql: (statement: string) => void }) => void;
  down: (pgm: { sql: (statement: string) => void }) => void;
};

describe("workspace Jira site URL uniqueness migration", () => {
  it("guards duplicates, normalizes existing Jira site URLs, then adds the partial unique index", () => {
    const sql = vi.fn();

    migration.up({ sql });

    const ddl = sql.mock.calls.map(([statement]) => statement).join("\n");
    expect(ddl).toContain("GROUP BY LOWER(TRIM(TRAILING '/' FROM provider_site_url))");
    expect(ddl).toContain("HAVING COUNT(*) > 1");
    expect(ddl).toContain("Resolve duplicate Jira site URLs before applying the Jira site bootstrap migration");
    expect(ddl).toContain("SET provider_site_url = LOWER(TRIM(TRAILING '/' FROM provider_site_url))");
    // Guard and normalization touch only Jira rows; Azure rows keep their org URLs untouched.
    expect(ddl).toContain("provider_id = 'jira-cloud'");
    expect(ddl).not.toMatch(/UPDATE workspaces[\s\S]*azure_org_url/);
    expect(ddl).toContain("CREATE UNIQUE INDEX idx_workspaces_provider_site_url");
    expect(ddl).toContain("ON workspaces(provider_id, provider_site_url)");
    expect(ddl).toContain("WHERE provider_site_url IS NOT NULL");
    // The guard must run before the index creation.
    expect(ddl.indexOf("HAVING COUNT(*) > 1")).toBeLessThan(ddl.indexOf("CREATE UNIQUE INDEX idx_workspaces_provider_site_url"));
  });

  it("drops the unique index on rollback", () => {
    const sql = vi.fn();
    migration.down({ sql });
    const ddl = String(sql.mock.calls[0][0]);
    expect(ddl).toContain("DROP INDEX IF EXISTS idx_workspaces_provider_site_url");
  });
});
