import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const migration = require("../../../migrations/1710000046000_jira_oauth_state_selected_site.js") as {
  up: (pgm: { sql: (statement: string) => void }) => void;
  down: (pgm: { sql: (statement: string) => void }) => void;
};

describe("Jira OAuth state selected-site migration", () => {
  it("adds a nullable workspace identity with an explicit cascading foreign key", () => {
    const sql = vi.fn();
    migration.up({ sql });
    const ddl = sql.mock.calls.map(([statement]) => statement).join("\n");
    expect(ddl).toContain("ALTER TABLE jira_oauth_states ADD COLUMN selected_site_url text");
    expect(ddl).toContain(
      "ADD COLUMN selected_workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE",
    );
    expect(ddl).not.toMatch(/selected_(?:site_url|workspace_id)[^;]*NOT NULL/);
  });

  it("drops the workspace foreign key before the legacy URL column on rollback", () => {
    const sql = vi.fn();
    migration.down({ sql });
    const ddl = sql.mock.calls.map(([statement]) => statement).join("\n");
    expect(ddl).toContain("ALTER TABLE jira_oauth_states DROP COLUMN IF EXISTS selected_workspace_id");
    expect(ddl).toContain("ALTER TABLE jira_oauth_states DROP COLUMN IF EXISTS selected_site_url");
    expect(ddl.indexOf("selected_workspace_id")).toBeLessThan(ddl.indexOf("selected_site_url"));
  });
});
