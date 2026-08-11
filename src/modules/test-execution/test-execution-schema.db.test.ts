import { afterAll, beforeAll, expect, it } from "vitest";

import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { encryptSecret } from "@/modules/security/encryption.service";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

import {
  createEnvironmentProfile,
  deleteEnvironmentSession,
  getEnvironmentProfile,
  getEnvironmentSessionState,
  saveEnvironmentSessionState,
  updateEnvironmentProfile,
} from "./environment-profile.service";
import { EnvironmentConfigInputSchema } from "./schemas/test-execution.schemas";
import {
  finalizeActionRun,
  loadRunForExecution,
  markRunRunning,
  markStepRunning,
  startActionRun,
} from "./run-persistence.service";

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

async function insertStepRun(
  id: string,
  caseRunId: string,
  runId: string,
  scope: { projectId: string; workspaceId: string; azureProjectId: string },
) {
  await sqlRun(
    `INSERT INTO test_execution_step_runs (
       id, case_run_id, run_id, workspace_id, project_id, azure_project_id,
       order_index, action_json, created_at, updated_at
     ) VALUES (
       @id, @caseRunId, @runId, @workspaceId, @projectId, @azureProjectId,
       0, '{"instruction":"Verify data","expectedResult":"Data exists"}'::jsonb, @now, @now
     )`,
    { id, caseRunId, runId, ...scope, now: nowIso() },
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
    await sqlRun(`DELETE FROM workspace_test_egress_rules WHERE workspace_id IN (@wsA, @wsB)`, { wsA, wsB });
    // Immutable integration revisions leave only through the project cascade.
    await cleanupFixtures({ workspaceIds: [wsA, wsB], userIds: [userId] });
  });

  it("rejects environment profiles whose scope columns do not match one project row", async () => {
    await expect(
      insertProfile(uniqueTestId("tenv"), { projectId: projectB, workspaceId: wsA, azureProjectId: projectB }),
    ).rejects.toThrow(/foreign key/i);
    await insertProfile(uniqueTestId("tenv"), baseScope(projectA, wsA));
  });

  it("session state round-trips encrypted, upserts per profile, and expires eagerly", async () => {
    const profileId = uniqueTestId("tenv");
    await insertProfile(profileId, baseScope(projectA, wsA));
    const saveScope = {
      workspaceId: wsA,
      projectId: projectA,
      azureProjectId: projectA,
      environmentProfileId: profileId,
    };

    await saveEnvironmentSessionState({ ...saveScope, stateJson: '{"cookies":["first"],"origins":[]}' });
    const atRest = await sqlGet<{ encrypted_state: string }>(
      `SELECT encrypted_state FROM test_environment_sessions WHERE profile_id = @profileId`,
      { profileId },
    );
    expect(atRest?.encrypted_state).not.toContain("cookies");

    let stored = await getEnvironmentSessionState({ workspaceId: wsA, environmentProfileId: profileId });
    expect(stored?.stateJson).toBe('{"cookies":["first"],"origins":[]}');

    // Second save replaces the single per-profile row.
    await saveEnvironmentSessionState({ ...saveScope, stateJson: '{"cookies":["second"],"origins":[]}' });
    stored = await getEnvironmentSessionState({ workspaceId: wsA, environmentProfileId: profileId });
    expect(stored?.stateJson).toBe('{"cookies":["second"],"origins":[]}');

    // Past expiry: the read deletes the row and reports no session.
    await sqlRun(
      `UPDATE test_environment_sessions SET expires_at = @past WHERE profile_id = @profileId`,
      { past: new Date(Date.now() - 1_000).toISOString(), profileId },
    );
    stored = await getEnvironmentSessionState({ workspaceId: wsA, environmentProfileId: profileId });
    expect(stored).toBeNull();
    const gone = await sqlGet<{ id: string }>(
      `SELECT id FROM test_environment_sessions WHERE profile_id = @profileId`,
      { profileId },
    );
    expect(gone).toBeFalsy();

    // Idempotent delete on an absent row.
    expect(await deleteEnvironmentSession({ workspaceId: wsA, environmentProfileId: profileId })).toBe(false);
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

  it("supports API-only and database-only profiles while requiring at least one target", async () => {
    await sqlRun(
      `INSERT INTO test_environment_profiles (
         id, workspace_id, project_id, azure_project_id, name,
         api_config_json, created_by, created_at, updated_at
       ) VALUES (
         @id, @wsA, @projectA, @projectA, @name,
         '{"baseUrl":"https://api.example.com","auth":{"type":"none"}}'::jsonb,
         @userId, @now, @now
       )`,
      {
        id: uniqueTestId("tenv_api"),
        wsA,
        projectA,
        name: uniqueTestId("api_profile"),
        userId,
        now: nowIso(),
      },
    );
    await sqlRun(
      `INSERT INTO test_environment_profiles (
         id, workspace_id, project_id, azure_project_id, name,
         db_config_json, created_by, created_at, updated_at
       ) VALUES (
         @id, @wsA, @projectA, @projectA, @name,
         '{"driver":"postgres","host":"db.example.com","port":5432}'::jsonb,
         @userId, @now, @now
       )`,
      {
        id: uniqueTestId("tenv_db"),
        wsA,
        projectA,
        name: uniqueTestId("db_profile"),
        userId,
        now: nowIso(),
      },
    );
    await expect(
      sqlRun(
        `INSERT INTO test_environment_profiles (
           id, workspace_id, project_id, azure_project_id, name,
           created_by, created_at, updated_at
         ) VALUES (@id, @wsA, @projectA, @projectA, @name, @userId, @now, @now)`,
        {
          id: uniqueTestId("tenv_empty"),
          wsA,
          projectA,
          name: uniqueTestId("empty_profile"),
          userId,
          now: nowIso(),
        },
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  });

  it("round-trips multi-layer profile config and exposes only masked scoped credentials", async () => {
    const projectScope = {
      projectId: projectA,
      azureProjectId: projectA,
      azureProjectName: projectA,
      azureOrganizationUrl: orgA,
    };
    const created = await createEnvironmentProfile({
      workspaceId: wsA,
      scope: projectScope,
      actor: userId,
      config: EnvironmentConfigInputSchema.parse({
        name: uniqueTestId("service_profile"),
        api: {
          baseUrl: "https://api.example.com/v1",
          auth: { type: "bearer" },
        },
      }),
      secrets: [
        {
          secretName: "api.bearer_token",
          title: "API bearer token",
          value: "profile-api-secret",
          purpose: "api_auth",
        },
      ],
    });
    expect(created.initialUrl).toBe("");
    expect(created.api?.baseUrl).toBe("https://api.example.com/v1");
    expect(created.secrets).toEqual([
      expect.objectContaining({
        secretName: "api.bearer_token",
        purpose: "api_auth",
      }),
    ]);
    expect(JSON.stringify(created)).not.toContain("profile-api-secret");

    const updated = await updateEnvironmentProfile({
      workspaceId: wsA,
      scope: projectScope,
      actor: userId,
      environmentProfileId: created.id,
      config: {
        database: {
          driver: "postgres",
          host: "db.example.com",
          port: 5432,
          databaseName: "qa",
          username: "itestflow",
          tlsMode: "verify-full",
          schemas: ["public"],
          accessMode: "read_only",
          connectTimeoutMs: 10_000,
          statementTimeoutMs: 30_000,
        },
      },
      upsertSecrets: [
        {
          secretName: "db.password",
          title: "Database password",
          value: "profile-db-secret",
          purpose: "db_connection",
        },
      ],
      removeSecretNames: [],
    });
    expect(updated?.database).toMatchObject({ driver: "postgres", databaseName: "qa" });
    expect(updated?.secrets.map((secret) => secret.purpose).sort()).toEqual(["api_auth", "db_connection"]);

    const loaded = await getEnvironmentProfile({
      workspaceId: wsA,
      scope: projectScope,
      environmentProfileId: created.id,
    });
    expect(loaded?.api?.auth.type).toBe("bearer");
    expect(loaded?.database?.schemas).toEqual(["public"]);
    expect(JSON.stringify(loaded)).not.toContain("profile-db-secret");
  });

  it("purpose-scopes reserved connection secrets", async () => {
    const profileId = uniqueTestId("tenv");
    await insertProfile(profileId, baseScope(projectA, wsA));
    await sqlRun(
      `INSERT INTO test_environment_secrets (
         id, profile_id, workspace_id, project_id, azure_project_id,
         secret_name, title, purpose, encrypted_secret, encryption_iv, encryption_tag,
         masked_preview, created_by, created_at, updated_at
       ) VALUES (
         @id, @profileId, @wsA, @projectA, @projectA,
         'db.password', 'Database password', 'db_connection', 'ct', 'iv', 'tag',
         'masked', @userId, @now, @now
       )`,
      { id: uniqueTestId("tsec"), profileId, wsA, projectA, userId, now: nowIso() },
    );
    await expect(
      sqlRun(
        `INSERT INTO test_environment_secrets (
           id, profile_id, workspace_id, project_id, azure_project_id,
           secret_name, title, purpose, encrypted_secret, encryption_iv, encryption_tag,
           masked_preview, created_by, created_at, updated_at
         ) VALUES (
           @id, @profileId, @wsA, @projectA, @projectA,
           'db.password.bad', 'Invalid', 'db_connection', 'ct', 'iv', 'tag',
           'masked', @userId, @now, @now
         )`,
        { id: uniqueTestId("tsec"), profileId, wsA, projectA, userId, now: nowIso() },
      ),
    ).rejects.toThrow(/check constraint|violates/i);
  });

  it("loads connection credentials separately from agent-visible secrets", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, baseScope(projectA, wsA));
    await sqlRun(
      `UPDATE test_execution_runs
       SET env_config_json = @envConfig::jsonb, status = 'completed', outcome = 'passed',
           finished_at = @now, updated_at = @now
       WHERE id = @runId`,
      {
        runId,
        envConfig: JSON.stringify({
          initialUrl: "https://app.example.com/login",
          allowedOrigin: "https://app.example.com",
        }),
        now: nowIso(),
      },
    );
    const insertRunSecret = async (
      secretName: string,
      purpose: "agent_value" | "db_connection",
      plaintext: string,
    ) => {
      const encrypted = encryptSecret(plaintext);
      await sqlRun(
        `INSERT INTO test_execution_run_secrets (
           id, run_id, workspace_id, project_id, azure_project_id, secret_name, title,
           purpose, encrypted_secret, encryption_iv, encryption_tag, key_version,
           masked_preview, created_at
         ) VALUES (
           @id, @runId, @wsA, @projectA, @projectA, @secretName, @secretName,
           @purpose, @ciphertext, @iv, @tag, @keyVersion, 'masked', @now
         )`,
        {
          id: uniqueTestId("trs"),
          runId,
          wsA,
          projectA,
          secretName,
          purpose,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          tag: encrypted.tag,
          keyVersion: encrypted.keyVersion,
          now: nowIso(),
        },
      );
    };
    await insertRunSecret("DEFAULT_PASSWORD", "agent_value", "browser-secret");
    await insertRunSecret("db.password", "db_connection", "database-secret");

    const bundle = await loadRunForExecution(runId);
    expect(bundle?.secrets.get("DEFAULT_PASSWORD")).toBe("browser-secret");
    expect(bundle?.secrets.has("db.password")).toBe(false);
    expect(bundle?.secretTitles.has("db.password")).toBe(false);
    expect(bundle?.connectionSecrets.get("db.password")).toBe("database-secret");
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

  it("keeps integration revisions immutable and run pins project-scoped", async () => {
    const operationA = uniqueTestId("tiop");
    const operationA2 = uniqueTestId("tiop");
    const operationB = uniqueTestId("tiop");
    const insertOperation = async (
      id: string,
      scope: { workspaceId: string; projectId: string; azureProjectId: string },
    ) => {
      await sqlRun(
        `INSERT INTO test_integration_operation_revisions (
           id, workspace_id, project_id, azure_project_id, stable_key, display_name,
           revision, layer, source_kind, safety_class, parameter_schema_json,
           definition_json, approval_status, approved_by, approved_at, created_by, created_at
         ) VALUES (
           @id, @workspaceId, @projectId, @azureProjectId, @stableKey, 'Get customer',
           1, 'api', 'manual', 'read', '{}'::jsonb,
           '{"method":"GET","path":"/customers/{id}"}'::jsonb,
           'approved', @userId, @now, @userId, @now
         )`,
        { id, ...scope, stableKey: `get.customer.${id.toLowerCase()}`, userId, now: nowIso() },
      );
    };
    await insertOperation(operationA, baseScope(projectA, wsA));
    await insertOperation(operationA2, baseScope(projectA, wsA));
    await insertOperation(operationB, baseScope(projectB, wsB));
    await expect(
      sqlRun(
        `UPDATE test_integration_operation_revisions SET display_name = 'Changed' WHERE id = @id`,
        { id: operationA },
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      sqlRun(`DELETE FROM test_integration_operation_revisions WHERE id = @id`, { id: operationA }),
    ).rejects.toThrow(/immutable/i);

    const runId = uniqueTestId("trun");
    await insertRun(runId, baseScope(projectA, wsA));
    await expect(
      sqlRun(
        `INSERT INTO test_execution_run_capabilities (
           id, run_id, workspace_id, project_id, azure_project_id,
           capability_kind, operation_revision_id, created_at
         ) VALUES (
           @id, @runId, @wsA, @projectA, @projectA,
           'operation', @operationB, @now
         )`,
        {
          id: uniqueTestId("trcap"),
          runId,
          wsA,
          projectA,
          operationB,
          now: nowIso(),
        },
      ),
    ).rejects.toThrow(/foreign key/i);
    const pinId = uniqueTestId("trcap");
    await sqlRun(
      `INSERT INTO test_execution_run_capabilities (
         id, run_id, workspace_id, project_id, azure_project_id,
         capability_kind, operation_revision_id, created_at
       ) VALUES (
         @id, @runId, @wsA, @projectA, @projectA,
         'operation', @operationA, @now
       )`,
      { id: pinId, runId, wsA, projectA, operationA, now: nowIso() },
    );
    await expect(
      sqlRun(
        `UPDATE test_execution_run_capabilities SET operation_revision_id = @operationB WHERE id = @id`,
        { id: pinId, operationB },
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      sqlRun(`DELETE FROM test_execution_run_capabilities WHERE id = @id`, { id: pinId }),
    ).rejects.toThrow(/immutable/i);

    await sqlRun(
      `UPDATE test_execution_runs
       SET capability_snapshot_frozen_at = @now, updated_at = @now
       WHERE id = @runId`,
      { runId, now: nowIso() },
    );
    await expect(
      sqlRun(
        `INSERT INTO test_execution_run_capabilities (
           id, run_id, workspace_id, project_id, azure_project_id,
           capability_kind, operation_revision_id, created_at
         ) VALUES (
           @id, @runId, @wsA, @projectA, @projectA,
           'operation', @operationA2, @now
         )`,
        {
          id: uniqueTestId("trcap"),
          runId,
          wsA,
          projectA,
          operationA2,
          now: nowIso(),
        },
      ),
    ).rejects.toThrow(/immutable/i);
    await expect(
      sqlRun(
        `UPDATE test_execution_runs SET capability_snapshot_frozen_at = NULL WHERE id = @runId`,
        { runId },
      ),
    ).rejects.toThrow(/cannot be reopened/i);
    await sqlRun(
      `UPDATE test_execution_runs SET env_config_json = @envConfig::jsonb, updated_at = @now WHERE id = @runId`,
      {
        runId,
        envConfig: JSON.stringify({
          initialUrl: "",
          allowedOrigin: "",
          api: {
            baseUrl: "https://api.example.com",
            contract: null,
            auth: { type: "none" },
            requestTimeoutMs: 30_000,
            mutationMode: "disabled",
          },
        }),
        now: nowIso(),
      },
    );
    const frozen = await loadRunForExecution(runId);
    expect(frozen?.run.envConfig.initialUrl).toBe("");
    expect(frozen?.capabilities).toEqual([
      expect.objectContaining({ id: operationA, stableKey: expect.stringContaining("get.customer") }),
    ]);
    // Parent deletion remains the sole supported pin cleanup path.
    await sqlRun(`DELETE FROM test_execution_runs WHERE id = @runId`, { runId });
    await expect(
      sqlGet(`SELECT id FROM test_execution_run_capabilities WHERE id = @id`, { id: pinId }),
    ).resolves.toBeUndefined();
  });

  it("persists and finalizes action intent under the owning job fence", async () => {
    const runId = uniqueTestId("trun");
    const caseRunId = uniqueTestId("tcr");
    const stepRunId = uniqueTestId("tsr");
    const scope = baseScope(projectA, wsA);
    await insertRun(runId, scope);
    await insertCaseRun(caseRunId, runId, scope);
    await insertStepRun(stepRunId, caseRunId, runId, scope);
    expect(await markRunRunning(runId, "job-action")).toBe(true);
    await markStepRunning(runId, "job-action", stepRunId);

    const actionRunId = await startActionRun({
      runId,
      jobId: "job-action",
      workspaceId: wsA,
      projectId: projectA,
      azureProjectId: projectA,
      caseRunId,
      stepRunId,
      orderIndex: 0,
      layer: "api",
      actionType: "api.request",
      safetyClass: "read",
      request: { method: "GET", path: "/customers/42" },
    });
    expect(actionRunId).toBeTruthy();
    expect(
      await finalizeActionRun({
        runId,
        jobId: "wrong-job",
        actionRunId: actionRunId as string,
        status: "completed",
      }),
    ).toBe(false);
    expect(
      await finalizeActionRun({
        runId,
        jobId: "job-action",
        actionRunId: actionRunId as string,
        status: "completed",
        observation: { status: 200 },
      }),
    ).toBe(true);
    const action = await sqlGet<{ status: string; observation_json: { status: number } }>(
      `SELECT status, observation_json FROM test_execution_action_runs WHERE id = @id`,
      { id: actionRunId },
    );
    expect(action).toMatchObject({ status: "completed", observation_json: { status: 200 } });
    await sqlRun(
      `UPDATE test_execution_runs
       SET status = 'completed', outcome = 'passed', finished_at = @now, updated_at = @now
       WHERE id = @id`,
      { id: runId, now: nowIso() },
    );
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
