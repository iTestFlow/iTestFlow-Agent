import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("@/modules/jobs/test-execution-jobs.service", () => ({
  enqueueTestExecutionRunJob: vi.fn(async () => ({
    job: { id: "job_snapshot_test" },
    reused: false,
  })),
}));

import { sqlRun } from "@/modules/shared/infrastructure/database/db";
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
  updateEnvironmentProfile,
} from "./environment-profile.service";
import {
  createIntegrationOperation,
  transitionIntegrationOperation,
} from "./integration-capabilities.service";
import { loadRunForExecution, EnvConfigSchema } from "./run-persistence.service";
import {
  createRunWithSnapshots,
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

function oneTimeRun(capabilityRevisionIds: string[] = []) {
  return createRunWithSnapshots({
    workspaceId,
    scope,
    actor: userId,
    adapter: {} as never,
    environment: {
      profileId: null,
      profileUpdatedAt: null,
      config: apiEnvironment,
      oneTimeSecrets: [],
    },
    story: null,
    cases,
    capabilityRevisionIds,
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
    // Operation revisions are immutable except through their project cascade.
    await cleanupFixtures({ workspaceIds: [workspaceId], userIds: [userId] });
  });

  it("pins only the currently effective approved operation revision", async () => {
    const draft = await createIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operation: {
        stableKey: `api.health.${uniqueTestId("key").toLowerCase()}`,
        displayName: "Read health",
        layer: "api",
        sourceKind: "manual",
        safetyClass: "read",
        databaseDriver: null,
        apiContractRevisionId: null,
        parameterSchema: {},
        definition: { method: "GET", path: "/health" },
      },
    });
    const approved = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: draft.id,
      action: "approve",
    });
    const successorDraft = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: approved!.id,
      action: "revise",
      changes: { displayName: "Read health v2" },
    });

    // A draft successor does not hide the last approved revision.
    const firstRun = await oneTimeRun([approved!.id]);
    const firstBundle = await loadRunForExecution(firstRun.runId);
    expect(firstBundle?.capabilities).toEqual([
      expect.objectContaining({ id: approved!.id, revision: approved!.revision }),
    ]);
    await sqlRun(`DELETE FROM test_execution_runs WHERE id = @runId`, {
      runId: firstRun.runId,
    });

    const archived = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: successorDraft!.id,
      action: "archive",
    });
    await expect(oneTimeRun([approved!.id])).rejects.toBeInstanceOf(
      RunCapabilityValidationError,
    );

    const replacementDraft = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: archived!.id,
      action: "revise",
      changes: { displayName: "Read health replacement" },
    });
    const replacementApproved = await transitionIntegrationOperation({
      workspaceId,
      scope,
      actor: userId,
      operationRevisionId: replacementDraft!.id,
      action: "approve",
    });

    await expect(oneTimeRun([approved!.id])).rejects.toBeInstanceOf(
      RunCapabilityValidationError,
    );
    await expect(
      oneTimeRun([replacementApproved!.id, replacementApproved!.id]),
    ).rejects.toMatchObject({ reason: "duplicate_stable_key" });
    await expect(oneTimeRun([approved!.id, replacementApproved!.id])).rejects.toMatchObject({
      reason: "duplicate_stable_key",
    });

    const replacementRun = await oneTimeRun([replacementApproved!.id]);
    const replacementBundle = await loadRunForExecution(replacementRun.runId);
    expect(replacementBundle?.capabilities).toEqual([
      expect.objectContaining({
        id: replacementApproved!.id,
        revision: replacementApproved!.revision,
      }),
    ]);
    await sqlRun(`DELETE FROM test_execution_runs WHERE id = @runId`, {
      runId: replacementRun.runId,
    });
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
});
