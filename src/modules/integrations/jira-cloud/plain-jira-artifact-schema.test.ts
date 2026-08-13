import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("stores one configured artifact backend and stable local-to-remote identities", () => {
  const ddl = fs.readFileSync(path.join(process.cwd(), "migrations/1710000040000_jira_artifact_backends.js"), "utf8");
  expect(ddl).toContain("CREATE TABLE jira_artifact_backend_configs");
  expect(ddl).toContain("UNIQUE (workspace_id, project_id)");
  expect(ddl).toContain("CHECK (backend_type IN ('plain_jira', 'xray_cloud', 'zephyr_scale'))");
  expect(ddl).toContain("CREATE TABLE jira_artifact_links");
  expect(ddl).toContain("UNIQUE (workspace_id, project_id, local_artifact_type, local_artifact_id)");
  expect(ddl).toContain("UNIQUE (workspace_id, project_id, backend_type, remote_artifact_id)");
});
