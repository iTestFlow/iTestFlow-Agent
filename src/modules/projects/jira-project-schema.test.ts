import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const migration = require("../../../migrations/1710000038000_provider_project_identity.js") as {
  up: (pgm: { sql: (statement: string) => void }) => void;
  down: (pgm: { sql: (statement: string) => void }) => void;
};

describe("provider project identity migration", () => {
  it("adds and backfills provider-neutral project identity with workspace uniqueness", () => {
    const sql = vi.fn();
    migration.up({ sql });
    const ddl = String(sql.mock.calls[0][0]);
    expect(ddl).toContain("ADD COLUMN provider_project_id");
    expect(ddl).toContain("SET provider_project_id = azure_project_id");
    expect(ddl).toContain("CREATE UNIQUE INDEX idx_projects_provider_project");
    expect(ddl).toContain("ON projects(workspace_id, provider_id, provider_project_id)");
  });

  it("removes the index before its columns", () => {
    const sql = vi.fn();
    migration.down({ sql });
    const ddl = String(sql.mock.calls[0][0]);
    expect(ddl.indexOf("DROP INDEX")).toBeLessThan(ddl.indexOf("DROP COLUMN"));
  });
});
