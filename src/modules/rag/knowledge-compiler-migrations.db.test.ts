import { createRequire } from "node:module";

import { afterAll, beforeAll, expect, it } from "vitest";

import { getPool } from "@/modules/shared/infrastructure/database/db";
import { cleanupFixtures, describeDb, seedProject, seedWorkspace, uniqueTestId } from "@/test/db";

type SqlMigration = { up: (pgm: { sql: (statement: string) => void }) => void };

const require = createRequire(import.meta.url);
const foundation = require("../../../migrations/1710000015000_knowledge_compiler_foundation.js") as SqlMigration;
const corrections = require("../../../migrations/1710000018000_knowledge_compiler_safety_corrections.js") as SqlMigration;
const documentEvidence = require("../../../migrations/1710000035000_project_knowledge_document_evidence.js") as SqlMigration;

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

  it("supersedes only in-flight old-contract drafts and flags only old-contract knowledge bases", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const now = new Date().toISOString();

      const oldContractProjectId = uniqueTestId("project_old_contract");
      const newContractProjectId = uniqueTestId("project_new_contract");
      const generatingDraftId = uniqueTestId("pkd_generating");
      const readyToPublishDraftId = uniqueTestId("pkd_ready_to_publish");
      const rebaseRequiredDraftId = uniqueTestId("pkd_rebase_required");
      const publishedDraftId = uniqueTestId("pkd_published");
      const newContractDraftId = uniqueTestId("pkd_new_contract");

      await client.query(
        `INSERT INTO project_knowledge_drafts (
           id, workspace_id, project_id, azure_project_id, azure_project_name,
           azure_organization_url, generation_mode, compilation_mode, status,
           status_reason, source_fingerprint, compiler_contract_version,
           wording_version, created_by, created_at, updated_at
         ) VALUES
         ($1, $2, $3, $3, 'Old Contract Project', $4, 'automatic', 'full', 'generating',
          NULL, 'fingerprint-1', '4.2.0', '4.0.0', 'system', $5, $5),
         ($6, $2, $3, $3, 'Old Contract Project', $4, 'automatic', 'full', 'ready_to_publish',
          NULL, 'fingerprint-2', '4.2.0', '4.0.0', 'system', $5, $5),
         ($7, $2, $3, $3, 'Old Contract Project', $4, 'automatic', 'full', 'rebase_required',
          NULL, 'fingerprint-3', '4.2.0', '4.0.0', 'system', $5, $5),
         ($8, $2, $3, $3, 'Old Contract Project', $4, 'automatic', 'full', 'published',
          NULL, 'fingerprint-4', '4.2.0', '4.0.0', 'system', $5, $5),
         ($9, $2, $10, $10, 'New Contract Project', $4, 'automatic', 'full', 'awaiting_input',
          NULL, 'fingerprint-5', '5.0.0', '4.0.0', 'system', $5, $5)`,
        [
          generatingDraftId,
          workspaceId,
          oldContractProjectId,
          organizationUrl,
          now,
          readyToPublishDraftId,
          rebaseRequiredDraftId,
          publishedDraftId,
          newContractDraftId,
          newContractProjectId,
        ],
      );

      await client.query(
        `INSERT INTO project_knowledge_base (
           id, project_id, azure_project_id, azure_project_name, azure_organization_url,
           prompt_version, validated_output, status, extracted_at, created_at, updated_at,
           compiler_contract_version, compiler_compatibility
         ) VALUES
         ($1, $2, $2, 'Old Contract Project', $3, 'original', '{}', 'Success', $4, $4, $4, '4.2.0', 'current'),
         ($5, $6, $6, 'New Contract Project', $3, 'original', '{}', 'Success', $4, $4, $4, '5.0.0', 'current')`,
        [
          uniqueTestId("pkb_old_contract"),
          oldContractProjectId,
          organizationUrl,
          now,
          uniqueTestId("pkb_new_contract"),
          newContractProjectId,
        ],
      );

      await client.query(migrationSql(documentEvidence));

      const drafts = await client.query<{ id: string; status: string; status_reason: string | null }>(
        `SELECT id, status, status_reason
         FROM project_knowledge_drafts
         WHERE id = ANY($1::text[])
         ORDER BY id`,
        [[generatingDraftId, readyToPublishDraftId, rebaseRequiredDraftId, publishedDraftId, newContractDraftId]],
      );
      const draftsById = new Map(drafts.rows.map((row) => [row.id, row]));
      expect(draftsById.get(generatingDraftId)).toEqual({
        id: generatingDraftId,
        status: "superseded",
        status_reason: "documents_evidence_upgrade_requires_new_build",
      });
      expect(draftsById.get(readyToPublishDraftId)).toEqual({
        id: readyToPublishDraftId,
        status: "superseded",
        status_reason: "documents_evidence_upgrade_requires_new_build",
      });
      expect(draftsById.get(rebaseRequiredDraftId)).toEqual({
        id: rebaseRequiredDraftId,
        status: "superseded",
        status_reason: "documents_evidence_upgrade_requires_new_build",
      });
      expect(draftsById.get(publishedDraftId)).toEqual({
        id: publishedDraftId,
        status: "published",
        status_reason: null,
      });
      expect(draftsById.get(newContractDraftId)).toEqual({
        id: newContractDraftId,
        status: "awaiting_input",
        status_reason: null,
      });

      const knowledgeBases = await client.query<{ project_id: string; compiler_compatibility: string }>(
        `SELECT project_id, compiler_compatibility
         FROM project_knowledge_base
         WHERE project_id = ANY($1::text[])
         ORDER BY project_id`,
        [[oldContractProjectId, newContractProjectId]],
      );
      expect(new Map(knowledgeBases.rows.map((row) => [row.project_id, row.compiler_compatibility]))).toEqual(new Map([
        [oldContractProjectId, "upgrade_required"],
        [newContractProjectId, "current"],
      ]));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
