import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const migration = require("../../../migrations/1710000046000_jira_oauth_state_selected_site.js") as {
  up: (pgm: { sql: (statement: string) => void }) => void;
  down: (pgm: { sql: (statement: string) => void }) => void;
};

describe("Jira OAuth state selected-site migration", () => {
  it("adds the nullable selected_site_url column", () => {
    const sql = vi.fn();
    migration.up({ sql });
    const ddl = sql.mock.calls.map(([statement]) => statement).join("\n");
    expect(ddl).toContain("ALTER TABLE jira_oauth_states ADD COLUMN selected_site_url text");
    expect(ddl).not.toContain("NOT NULL");
  });

  it("drops the column on rollback", () => {
    const sql = vi.fn();
    migration.down({ sql });
    expect(String(sql.mock.calls[0][0])).toContain(
      "ALTER TABLE jira_oauth_states DROP COLUMN IF EXISTS selected_site_url",
    );
  });
});
