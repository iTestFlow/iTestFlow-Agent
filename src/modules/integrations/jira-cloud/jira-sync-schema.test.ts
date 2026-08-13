import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

it("persists renewable webhooks, idempotent deliveries, baselines, and field conflicts", () => {
  const ddl = fs.readFileSync(path.join(process.cwd(), "migrations/1710000039000_jira_sync_foundation.js"), "utf8");
  expect(ddl).toContain("CREATE TABLE jira_webhooks");
  expect(ddl).toContain("expires_at text");
  expect(ddl).toContain("CREATE TABLE jira_webhook_events");
  expect(ddl).toContain("UNIQUE (cloud_id, delivery_id)");
  expect(ddl).toContain("callback_key_hash text NOT NULL UNIQUE");
  expect(ddl.match(/FOREIGN KEY \(workspace_id, project_id\) REFERENCES projects\(workspace_id, id\)/g)).toHaveLength(3);
  expect(ddl).toContain("CREATE TABLE jira_sync_mappings");
  expect(ddl).toContain("CHECK (direction IN ('jira_to_itestflow', 'itestflow_to_jira', 'two_way'))");
  expect(ddl).toContain("CREATE TABLE jira_sync_field_states");
  expect(ddl).toContain("CHECK (status IN ('in_sync', 'pending', 'conflict', 'error'))");
  expect(ddl).toContain("CREATE TABLE jira_sync_operations");
  expect(ddl).toContain("CHECK (operation IN ('pull', 'push'))");
  expect(ddl.indexOf("DROP TABLE IF EXISTS jira_sync_operations")).toBeLessThan(ddl.indexOf("DROP TABLE IF EXISTS jira_sync_field_states"));
  expect(ddl.indexOf("DROP TABLE IF EXISTS jira_sync_field_states")).toBeLessThan(ddl.indexOf("DROP TABLE IF EXISTS jira_sync_mappings"));
});
