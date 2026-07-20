import { createRequire } from "node:module";

import { afterAll, beforeAll, expect, it } from "vitest";

import { getPool } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

type SqlMigration = { up: (pgm: { sql: (statement: string) => void }) => void };

const require = createRequire(import.meta.url);
const foundation = require("../../../migrations/1710000015000_knowledge_compiler_foundation.js") as SqlMigration;
const corrections = require("../../../migrations/1710000018000_knowledge_compiler_safety_corrections.js") as SqlMigration;

function migrationSql(migration: SqlMigration) {
  const statements: string[] = [];
  migration.up({ sql: (statement) => statements.push(statement) });
  return statements.join("\n");
}

describeDb("knowledge compiler migration regressions", () => {
  const workspaceId = uniqueTestId("ws_migration");
  const projectId = uniqueTestId("project_migration");
  const organizationUrl = `https://dev.azure.com/${uniqueTestId("org_migration")}`;

  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl: organizationUrl });
    await seedProject({
      workspaceId,
      orgUrl: organizationUrl,
      azureProjectId: projectId,
      azureProjectName: "Migration Project",
    });
  });

  afterAll(async () => {
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [] });
  });

  it("recovers only current snapshot revisions and skips an occupied sibling identity", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const now = new Date().toISOString();
      const collisionWorkItemId = uniqueTestId("awi_collision");
      const collisionCurrentId = uniqueTestId("awis_collision_current");
      const collisionSiblingId = uniqueTestId("awis_collision_sibling");
      const recoverableWorkItemId = uniqueTestId("awi_recoverable");
      const recoverableCurrentId = uniqueTestId("awis_recoverable_current");
      const recoverableHistoricalId = uniqueTestId("awis_recoverable_historical");

      await client.query(
        `INSERT INTO azure_devops_work_items (
           id, workspace_id, project_id, azure_project_id, azure_project_name,
           azure_organization_url, azure_work_item_id, work_item_type, title,
           raw_json, content_hash, current_snapshot_id, created_at, updated_at
         ) VALUES
         ($1, $2, $3, $3, 'Migration Project', $4, '101', 'User Story', 'Collision',
          '{"rev": 11}', 'collision-hash', $5, $7, $7),
         ($6, $2, $3, $3, 'Migration Project', $4, '102', 'User Story', 'Recoverable',
          '{"rev": 12}', 'current-hash', $8, $7, $7)`,
        [
          collisionWorkItemId,
          workspaceId,
          projectId,
          organizationUrl,
          collisionCurrentId,
          recoverableWorkItemId,
          now,
          recoverableCurrentId,
        ],
      );
      await client.query(
        `INSERT INTO azure_devops_work_item_snapshots (
           id, workspace_id, project_id, azure_project_id, azure_project_name,
           azure_organization_url, azure_work_item_id, work_item_type, content_hash,
           ado_revision, fields_json, captured_at, created_at
         ) VALUES
         ($1, $2, $3, $3, 'Migration Project', $4, '101', 'User Story', 'collision-hash', NULL, '{}'::jsonb, $7, $7),
         ($5, $2, $3, $3, 'Migration Project', $4, '101', 'User Story', 'collision-hash', 11, '{}'::jsonb, $7, $7),
         ($6, $2, $3, $3, 'Migration Project', $4, '102', 'User Story', 'current-hash', NULL, '{}'::jsonb, $7, $7),
         ($8, $2, $3, $3, 'Migration Project', $4, '102', 'User Story', 'historical-hash', NULL, '{}'::jsonb, $7, $7)`,
        [
          collisionCurrentId,
          workspaceId,
          projectId,
          organizationUrl,
          collisionSiblingId,
          recoverableCurrentId,
          now,
          recoverableHistoricalId,
        ],
      );

      await client.query(migrationSql(corrections));

      const result = await client.query<{ id: string; ado_revision: number | null }>(
        `SELECT id, ado_revision
         FROM azure_devops_work_item_snapshots
         WHERE id = ANY($1::text[])
         ORDER BY id`,
        [[collisionCurrentId, collisionSiblingId, recoverableCurrentId, recoverableHistoricalId]],
      );
      expect(new Map(result.rows.map((row) => [row.id, row.ado_revision]))).toEqual(new Map([
        [collisionCurrentId, null],
        [collisionSiblingId, 11],
        [recoverableCurrentId, 12],
        [recoverableHistoricalId, null],
      ]));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it.each([
    ["truncated JSON", '["101",'],
    ["valid non-array JSON", '"101"'],
  ])("migrates %s candidate source IDs as an empty array", async (_label, sourceWorkItemIds) => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const versionId = uniqueTestId("pkev_candidate");
      const now = new Date().toISOString();
      await client.query(
        `INSERT INTO project_knowledge_entry_versions (
           id, workspace_id, project_id, azure_project_id, azure_project_name,
           azure_organization_url, knowledge_base_id, revision_id, category,
           entry_key, title, content, status, source_work_item_ids, evidence,
           content_hash, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $3, 'Migration Project', $4, 'pending', 'pending', 'module',
           'candidate', 'Candidate', 'Candidate content', 'candidate', $5,
           'Legacy evidence', 'candidate-hash', $6, $6
         )`,
        [versionId, workspaceId, projectId, organizationUrl, sourceWorkItemIds, now],
      );

      await client.query(migrationSql(foundation));

      const candidate = await client.query<{ source_work_item_ids: unknown }>(
        `SELECT source_work_item_ids
         FROM project_knowledge_candidates
         WHERE legacy_entry_version_id = $1`,
        [versionId],
      );
      expect(candidate.rows).toEqual([{ source_work_item_ids: [] }]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
