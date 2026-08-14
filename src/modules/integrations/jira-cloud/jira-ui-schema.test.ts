import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Jira UI configuration schema", () => {
  it("persists one project-owned sync configuration with reversible constraints", () => {
    const migrationDir = join(process.cwd(), "migrations");
    const sql = readdirSync(migrationDir)
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(migrationDir, name), "utf8"))
      .join("\n");

    expect(sql).toContain("CREATE TABLE jira_project_sync_configs");
    expect(sql).toContain("UNIQUE (workspace_id, project_id)");
    expect(sql).toContain("FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE CASCADE");
    expect(sql).toContain("direction IN ('jira_to_itestflow', 'itestflow_to_jira', 'two_way')");
    expect(sql).toContain("DROP TABLE IF EXISTS jira_project_sync_configs");
  });
});
