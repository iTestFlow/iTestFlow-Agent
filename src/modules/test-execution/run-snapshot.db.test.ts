import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/modules/jobs/test-execution-jobs.service", () => ({
  enqueueTestExecutionRunJob: vi.fn(async () => ({
    job: { id: "job_snapshot_test" },
    reused: false,
  })),
}));

import { nowIso, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";
import { fakeAzureAdapter, requirement, testCase } from "@/test/factories";

import {
  createEnvironmentProfile,
  updateEnvironmentProfile,
} from "./environment-profile.service";
import { loadRunForExecution, EnvConfigSchema } from "./run-persistence.service";
import {
  createRunWithSnapshots,
  loadRunDetailChangeRows,
  loadRunDetailRows,
  profileToEnvConfig,
  RunCapabilityValidationError,
  RunEnvironmentSnapshotConflictError,
} from "./run.service";
import { EnvironmentConfigInputSchema } from "./schemas/test-execution.schemas";

const workspaceId = uniqueTestId("ws_snapshot");
const projectId = uniqueTestId("proj_snapshot");
const userId = uniqueTestId("usr_snapshot");
const orgUrl = `https://dev.azure.com/${workspaceId}`;
const scope = {
  projectId,
  azureProjectId: projectId,
  azureProjectName: projectId,
  azureOrganizationUrl: orgUrl,
};

const apiEnvironment = EnvConfigSchema.parse({
  api: {
    baseUrl: "https://api.example.com",
    auth: { type: "none" },
  },
});

const cases = [
  {
    title: "API health check",
    sourceKind: "manual" as const,
    azureTestCaseId: null,
    plan: {
      schemaVersion: "v2-natural" as const,
      steps: [
        {
          instruction: "Call the health endpoint.",
          expectedResult: "The API reports healthy.",
          layerHint: "api" as const,
        },
      ],
    },
  },
];

function oneTimeRun(config = apiEnvironment) {
  return createRunWithSnapshots({
    workspaceId,
    scope,
    actor: userId,
    adapter: {} as never,
    environment: {
      profileId: null,
      profileUpdatedAt: null,
      config,
      oneTimeSecrets: [],
    },
    story: null,
    cases,
  });
}

describeDb("run snapshot selection", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: workspaceId, orgUrl });
    await seedUser({ id: userId, email: `${userId}@example.com` });
    await seedProject({ workspaceId, orgUrl, azureProjectId: projectId });
  });

  afterAll(async () => {
    await sqlRun(`DELETE FROM test_execution_runs WHERE workspace_id = @workspaceId`, {
      workspaceId,
    });
    await sqlRun(`DELETE FROM test_environment_profiles WHERE workspace_id = @workspaceId`, {
      workspaceId,
    });
    // Contract revisions are immutable except through their project cascade.
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
  });

  it("pins the reviewed API contract revision and stamps the capability freeze marker", async () => {
    const contractRevisionId = uniqueTestId("tacr");
    await sqlRun(
      `INSERT INTO test_api_contract_revisions (
         id, workspace_id, project_id, azure_project_id, stable_key, display_name,
         revision, source_kind, content_hash, normalized_spec_json, operation_count,
         created_by, created_at
       ) VALUES (
         @id, @workspaceId, @projectId, @projectId, @stableKey, 'Orders API',
         1, 'upload', @contentHash, '{"openapi":"3.1.0"}'::jsonb, 0, @userId, @now
       )`,
      {
        id: contractRevisionId,
        workspaceId,
        projectId,
        stableKey: `orders.api.${contractRevisionId.toLowerCase()}`,
        contentHash: "a".repeat(64),
        userId,
        now: nowIso(),
      },
    );

    const run = await oneTimeRun(EnvConfigSchema.parse({
      api: {
        baseUrl: "https://api.example.com",
        contract: { kind: "revision", revisionId: contractRevisionId },
        auth: { type: "none" },
      },
    }));
    const bundle = await loadRunForExecution(run.runId);
    expect(bundle?.apiContracts).toEqual([
      expect.objectContaining({ id: contractRevisionId, revision: 1, operationCount: 0 }),
    ]);
    // Operation pinning was removed with the manual capability catalog: a new
    // run derives its API/DB surface from the frozen environment alone.
    expect(bundle?.capabilities).toEqual([]);
    const frozen = await sqlGet<{ capability_snapshot_frozen_at: string | null }>(
      `SELECT capability_snapshot_frozen_at FROM test_execution_runs WHERE id = @runId`,
      { runId: run.runId },
    );
    expect(frozen?.capability_snapshot_frozen_at).toBeTruthy();
    await sqlRun(`DELETE FROM test_execution_runs WHERE id = @runId`, {
      runId: run.runId,
    });

    // An unknown (or out-of-scope) contract revision rejects the run.
    await expect(oneTimeRun(EnvConfigSchema.parse({
      api: {
        baseUrl: "https://api.example.com",
        contract: { kind: "revision", revisionId: uniqueTestId("tacr_missing") },
        auth: { type: "none" },
      },
    }))).rejects.toBeInstanceOf(RunCapabilityValidationError);
  });

  it("versions secret-only profile updates and rejects a stale reviewed snapshot", async () => {
    const staleProfile = await createEnvironmentProfile({
      workspaceId,
      scope,
      actor: userId,
      config: EnvironmentConfigInputSchema.parse({
        name: uniqueTestId("snapshot_profile"),
        api: {
          baseUrl: "https://api.example.com",
          auth: { type: "bearer" },
        },
      }),
      secrets: [
        {
          secretName: "api.bearer_token",
          title: "API bearer token",
          value: "old-profile-token",
          purpose: "api_auth",
        },
      ],
    });
    const updatedProfile = await updateEnvironmentProfile({
      workspaceId,
      scope,
      actor: userId,
      environmentProfileId: staleProfile.id,
      upsertSecrets: [
        {
          secretName: "api.bearer_token",
          title: "API bearer token",
          value: "new-profile-token",
          purpose: "api_auth",
        },
      ],
      removeSecretNames: [],
    });
    expect(updatedProfile).not.toBeNull();
    expect(updatedProfile!.updatedAt).not.toBe(staleProfile.updatedAt);

    await expect(
      createRunWithSnapshots({
        workspaceId,
        scope,
        actor: userId,
        adapter: {} as never,
        environment: {
          profileId: staleProfile.id,
          profileUpdatedAt: staleProfile.updatedAt,
          config: profileToEnvConfig(staleProfile),
          oneTimeSecrets: [],
        },
        story: null,
        cases,
      }),
    ).rejects.toBeInstanceOf(RunEnvironmentSnapshotConflictError);

    const freshRun = await createRunWithSnapshots({
      workspaceId,
      scope,
      actor: userId,
      adapter: {} as never,
      environment: {
        profileId: updatedProfile!.id,
        profileUpdatedAt: updatedProfile!.updatedAt,
        config: profileToEnvConfig(updatedProfile!),
        oneTimeSecrets: [],
      },
      story: null,
      cases,
    });
    const bundle = await loadRunForExecution(freshRun.runId);
    expect(bundle?.run.envConfig.api?.baseUrl).toBe("https://api.example.com");
    expect(bundle?.connectionSecrets.get("api.bearer_token")).toBe(
      "new-profile-token",
    );
    expect(bundle?.connectionSecrets.get("api.bearer_token")).not.toBe(
      "old-profile-token",
    );
    await sqlRun(`DELETE FROM test_execution_runs WHERE id = @runId`, {
      runId: freshRun.runId,
    });
  });

  it("exposes Azure case IDs in full and incremental run-detail rows", async () => {
    const storyWorkItemId = uniqueTestId("story_snapshot");
    const azureTestCaseId = uniqueTestId("case_snapshot");
    const run = await createRunWithSnapshots({
      workspaceId,
      scope,
      actor: userId,
      adapter: fakeAzureAdapter({
        fetchWorkItemById: vi.fn(async () => requirement({
          id: storyWorkItemId,
          azureProjectId: projectId,
          title: "Rerun source story",
        })),
        fetchLinkedTestCases: vi.fn(async () => [testCase({
          id: azureTestCaseId,
          azureTestCaseId,
          title: "Azure-backed rerun case",
        })]),
      }),
      environment: {
        profileId: null,
        profileUpdatedAt: null,
        config: apiEnvironment,
        oneTimeSecrets: [],
      },
      story: { workItemId: storyWorkItemId, title: "Rerun source story" },
      cases: [
        ...cases,
        {
          title: "Azure-backed rerun case",
          sourceKind: "azure_test_case",
          azureTestCaseId,
          plan: {
            schemaVersion: "v2-natural",
            steps: [{
              instruction: "Check the Azure-backed case.",
              expectedResult: "The case succeeds.",
              layerHint: "api",
            }],
          },
        },
      ],
    });

    const full = await loadRunDetailRows({ workspaceId, scope, runId: run.runId });
    expect(full?.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_kind: "manual", azure_work_item_id: null }),
      expect.objectContaining({
        source_kind: "azure_test_case",
        azure_work_item_id: azureTestCaseId,
      }),
    ]));

    const delta = await loadRunDetailChangeRows({
      workspaceId,
      scope,
      runId: run.runId,
      afterCursor: "0",
    });
    expect(delta?.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_kind: "manual", azure_work_item_id: null }),
      expect.objectContaining({
        source_kind: "azure_test_case",
        azure_work_item_id: azureTestCaseId,
      }),
    ]));
    expect(delta?.nextCursor).not.toBe("0");

    await sqlRun(`DELETE FROM test_execution_runs WHERE id = @runId`, {
      runId: run.runId,
    });
  });
});
