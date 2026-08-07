import { afterAll, beforeAll, expect, it } from "vitest";

import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

/**
 * Schema-level guarantees for the Test Execution tables (1710000037000-39000):
 * composite project-scope FKs reject cross-workspace rows, source snapshots
 * are immutable, only one run per project can be active, and the defect
 * publication ledger admits at most one non-failed row per candidate.
 */

const wsA = uniqueTestId("ws_texa");
const wsB = uniqueTestId("ws_texb");
const userId = uniqueTestId("usr_tex");
const projectA = uniqueTestId("proj_texa");
const projectB = uniqueTestId("proj_texb");
const orgA = `https://dev.azure.com/${wsA}`;
const orgB = `https://dev.azure.com/${wsB}`;

const HASH = "a".repeat(64);

function baseScope(projectId: string, workspaceId: string) {
  return { projectId, workspaceId, azureProjectId: projectId };
}

async function insertProfile(id: string, scope: { projectId: string; workspaceId: string; azureProjectId: string }) {
  await sqlRun(
    `INSERT INTO test_environment_profiles (
       id, workspace_id, project_id, azure_project_id, name,
       initial_url, allowed_origin, created_by, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @projectId, @azureProjectId, @name,
       'https://app.example.com/login', 'https://app.example.com', @userId, @now, @now
     )`,
    { id, ...scope, name: id, userId, now: nowIso() },
  );
}

async function insertRun(id: string, scope: { projectId: string; workspaceId: string; azureProjectId: string }) {
  await sqlRun(
    `INSERT INTO test_execution_runs (
       id, workspace_id, project_id, azure_project_id, env_config_json,
       approved_by, approved_at, created_by, created_at, updated_at
     ) VALUES (
       @id, @workspaceId, @projectId, @azureProjectId, '{}'::jsonb,
       @userId, @now, @userId, @now, @now
     )`,
    { id, ...scope, userId, now: nowIso() },
  );
}

async function completeRun(id: string) {
  await sqlRun(
    `UPDATE test_execution_runs
     SET status = 'completed', outcome = 'passed', finished_at = @now, updated_at = @now
     WHERE id = @id`,
    { id, now: nowIso() },
  );
}

async function insertCaseRun(
  id: string,
  runId: string,
  scope: { projectId: string; workspaceId: string; azureProjectId: string },
) {
  await sqlRun(
    `INSERT INTO test_execution_case_runs (
       id, run_id, workspace_id, project_id, azure_project_id, order_index,
       source_kind, title, compiled_plan_json, compile_source, created_at, updated_at
     ) VALUES (
       @id, @runId, @workspaceId, @projectId, @azureProjectId, 0,
       'manual', 'Case', '{"schemaVersion":"v1","steps":[]}'::jsonb, 'manual_typed', @now, @now
     )`,
    { id, runId, ...scope, now: nowIso() },
  );
}

describeDb("test execution schema", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: wsA, orgUrl: orgA });
    await seedWorkspace({ id: wsB, orgUrl: orgB });
    await seedUser({ id: userId, email: `${userId}@example.com` });
    await seedProject({ workspaceId: wsA, orgUrl: orgA, azureProjectId: projectA });
    await seedProject({ workspaceId: wsB, orgUrl: orgB, azureProjectId: projectB });
  });

  afterAll(async () => {
    await sqlRun(`DELETE FROM test_execution_runs WHERE workspace_id IN (@wsA, @wsB)`, { wsA, wsB });
    await sqlRun(`DELETE FROM test_environment_profiles WHERE workspace_id IN (@wsA, @wsB)`, { wsA, wsB });
    await cleanupFixtures({ workspaceIds: [wsA, wsB], userIds: [userId] });
  });

  it("rejects environment profiles whose scope columns do not match one project row", async () => {
    await expect(
      insertProfile(uniqueTestId("tenv"), { projectId: projectB, workspaceId: wsA, azureProjectId: projectB }),
    ).rejects.toThrow(/foreign key/i);
    await insertProfile(uniqueTestId("tenv"), baseScope(projectA, wsA));
  });

  it("enforces unique secret names per profile", async () => {
    const profileId = uniqueTestId("tenv");
    await insertProfile(profileId, baseScope(projectA, wsA));
    const insertSecret = (id: string) =>
      sqlRun(
        `INSERT INTO test_environment_secrets (
           id, profile_id, workspace_id, project_id, azure_project_id,
           secret_name, title, encrypted_secret, encryption_iv, encryption_tag,
           masked_preview, created_by, created_at, updated_at
         ) VALUES (
           @id, @profileId, @wsA, @projectA, @projectA,
           'PASSWORD', 'Password', 'ct', 'iv', 'tag', '••••', @userId, @now, @now
         )`,
        { id, profileId, wsA, projectA, userId, now: nowIso() },
      );
    await insertSecret(uniqueTestId("tsec"));
    await expect(insertSecret(uniqueTestId("tsec"))).rejects.toThrow(/duplicate key|unique/i);
  });

  it("allows only one queued/running run per project", async () => {
    const first = uniqueTestId("trun");
    await insertRun(first, baseScope(projectA, wsA));
    await expect(insertRun(uniqueTestId("trun"), baseScope(projectA, wsA))).rejects.toThrow(
      /duplicate key|unique/i,
    );
    await completeRun(first);
    const second = uniqueTestId("trun");
    await insertRun(second, baseScope(projectA, wsA));
    await completeRun(second);
  });

  it("keeps source snapshots immutable after insert", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, baseScope(projectA, wsA));
    const snapshotId = uniqueTestId("tsnap");
    await sqlRun(
      `INSERT INTO test_execution_source_snapshots (
         id, run_id, workspace_id, project_id, azure_project_id,
         kind, azure_work_item_id, azure_revision, payload_json, content_hash, created_at
       ) VALUES (
         @id, @runId, @wsA, @projectA, @projectA,
         'user_story', '123', 4, '{"title":"Story"}'::jsonb, @hash, @now
       )`,
      { id: snapshotId, runId, wsA, projectA, hash: HASH, now: nowIso() },
    );
    await expect(
      sqlRun(`UPDATE test_execution_source_snapshots SET azure_revision = 5 WHERE id = @id`, {
        id: snapshotId,
      }),
    ).rejects.toThrow(/immutable/i);
    await completeRun(runId);
  });

  it("rejects run outcomes on non-terminal statuses", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, baseScope(projectA, wsA));
    await expect(
      sqlRun(`UPDATE test_execution_runs SET outcome = 'passed' WHERE id = @id`, { id: runId }),
    ).rejects.toThrow(/check constraint|violates/i);
    await completeRun(runId);
  });

  it("admits at most one non-failed publication per defect candidate", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, baseScope(projectA, wsA));
    const caseRunId = uniqueTestId("tcr");
    await insertCaseRun(caseRunId, runId, baseScope(projectA, wsA));
    const candidateId = uniqueTestId("tdc");
    await sqlRun(
      `INSERT INTO test_defect_candidates (
         id, run_id, case_run_id, workspace_id, project_id, azure_project_id,
         draft_json, created_at, updated_at
       ) VALUES (
         @id, @runId, @caseRunId, @wsA, @projectA, @projectA,
         '{"title":"Bug"}'::jsonb, @now, @now
       )`,
      { id: candidateId, runId, caseRunId, wsA, projectA, now: nowIso() },
    );

    const insertPublication = (id: string) =>
      sqlRun(
        `INSERT INTO test_defect_publications (
           id, candidate_id, workspace_id, project_id, azure_project_id,
           published_by, created_at, updated_at
         ) VALUES (
           @id, @candidateId, @wsA, @projectA, @projectA, @userId, @now, @now
         )`,
        { id, candidateId, wsA, projectA, userId, now: nowIso() },
      );

    const firstPublication = uniqueTestId("tpub");
    await insertPublication(firstPublication);
    await expect(insertPublication(uniqueTestId("tpub"))).rejects.toThrow(/duplicate key|unique/i);

    await sqlRun(
      `UPDATE test_defect_publications SET status = 'failed', error_message = 'boom', updated_at = @now WHERE id = @id`,
      { id: firstPublication, now: nowIso() },
    );
    await insertPublication(uniqueTestId("tpub"));
    await completeRun(runId);
  });

  it("cascades the full execution chain when a run is deleted", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, baseScope(projectA, wsA));
    const caseRunId = uniqueTestId("tcr");
    await insertCaseRun(caseRunId, runId, baseScope(projectA, wsA));
    await sqlRun(`DELETE FROM test_execution_runs WHERE id = @id`, { id: runId });
    const row = await sqlGet(`SELECT id FROM test_execution_case_runs WHERE id = @id`, {
      id: caseRunId,
    });
    expect(row).toBeUndefined();
  });
});
