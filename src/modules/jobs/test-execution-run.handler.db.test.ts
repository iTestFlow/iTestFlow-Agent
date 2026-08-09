import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import { nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { encryptSecret, maskSecret } from "@/modules/security/encryption.service";
import type { StorageBackend } from "@/modules/documents/storage/storage-backend.port";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { setExecutionArtifactStorageBackendForTests } from "@/modules/test-execution/artifact-storage.service";
import { FakeBrowserExecutor } from "@/modules/integrations/browser-automation/fake-browser-executor";
import {
  cleanupFixtures,
  describeDb,
  seedProject,
  seedUser,
  seedWorkspace,
  uniqueTestId,
} from "@/test/db";

import type { Job } from "./job-queue.service";
import {
  runTestExecutionRunJob,
  setTestExecutionExecutorFactoryForTests,
  setTestExecutionLlmProviderFactoryForTests,
} from "./test-execution-run.handler";
import { TEST_EXECUTION_RUN } from "./test-execution-jobs.service";
import {
  getEnvironmentSessionState,
  saveEnvironmentSessionState,
} from "@/modules/test-execution/environment-profile.service";

/**
 * End-to-end handler behavior against real rows with the agentic loop driven
 * by a sequenced fake provider (each entry = one model turn, consumed across
 * the whole run) and the scripted fake browser executor. Covers outcome
 * persistence, rollups, evidence records, job-fenced writes, cancellation,
 * and the failed-test-is-a-completed-job contract — no real browser or LLM.
 */

const ws = uniqueTestId("ws_texh");
const userId = uniqueTestId("usr_texh");
const project = uniqueTestId("proj_texh");
const orgUrl = `https://dev.azure.com/${ws}`;
const workerId = "worker-test-executor";

function fakeStorage(): StorageBackend & { blobs: Map<string, number> } {
  const blobs = new Map<string, number>();
  return {
    kind: "local_fs",
    blobs,
    async put(input) {
      let size = 0;
      for await (const chunk of input.content as AsyncIterable<Uint8Array>) size += chunk.length;
      const storageKey = `ws/${input.workspaceId}/${input.contentSha256.slice(0, 2)}/${input.contentSha256}`;
      const created = !blobs.has(storageKey);
      blobs.set(storageKey, size);
      return { storageKey, byteSize: size, created };
    },
    async getStream() {
      return Readable.from(Buffer.from("x"));
    },
    async exists() {
      return true;
    },
    async delete() {
      return { deleted: false };
    },
  };
}

function sequencedProvider(outputs: Record<string, unknown>[]): LLMProvider {
  const generateStructuredOutput = vi.fn();
  for (const output of outputs) {
    generateStructuredOutput.mockResolvedValueOnce({
      provider: "anthropic",
      model: "claude-sonnet-5",
      rawOutput: "{}",
      validatedOutput: output,
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
    });
  }
  // Anything past the script keeps the run moving as a pass.
  generateStructuredOutput.mockResolvedValue({
    provider: "anthropic",
    model: "claude-sonnet-5",
    rawOutput: "{}",
    validatedOutput: { decision: "step_passed", actualResult: "ok" },
    tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    warnings: [],
  });
  return {
    testConnection: vi.fn(),
    getTokenUsage: vi.fn(() => ({ inputTokens: 100, outputTokens: 50, totalTokens: 150 })),
    generateText: vi.fn(),
    generateStructuredOutput,
    maxInputTokens: 100_000,
  } as unknown as LLMProvider;
}

const ENV_CONFIG = {
  initialUrl: "https://app.example.com/login",
  allowedOrigin: "https://app.example.com",
  viewportWidth: 1280,
  viewportHeight: 720,
  headless: true,
  defaultTimeoutMs: 5000,
  navigationTimeoutMs: 15000,
  evidenceLevel: "on_failure",
  loginPlan: null as unknown,
};

async function insertRun(
  runId: string,
  envConfig: Record<string, unknown> = ENV_CONFIG,
  environmentProfileId: string | null = null,
) {
  await sqlRun(
    `INSERT INTO test_execution_runs (
       id, workspace_id, project_id, azure_project_id, environment_profile_id, env_config_json,
       approved_by, approved_at, created_by, created_at, updated_at
     ) VALUES (@id, @ws, @project, @project, @profileId, @env::jsonb, @userId, @now, @userId, @now, @now)`,
    { id: runId, ws, project, profileId: environmentProfileId, env: JSON.stringify(envConfig), userId, now: nowIso() },
  );
}

async function insertProfile(profileId: string) {
  await sqlRun(
    `INSERT INTO test_environment_profiles (
       id, workspace_id, project_id, azure_project_id, name, initial_url, allowed_origin,
       created_by, created_at, updated_at
     ) VALUES (@id, @ws, @project, @project, @name, 'https://app.example.com/login', 'https://app.example.com',
       @userId, @now, @now)`,
    { id: profileId, ws, project, name: profileId, userId, now: nowIso() },
  );
}

async function insertSecret(runId: string, name: string, value: string) {
  const encrypted = encryptSecret(value);
  await sqlRun(
    `INSERT INTO test_execution_run_secrets (
       id, run_id, workspace_id, project_id, azure_project_id, secret_name, title,
       encrypted_secret, encryption_iv, encryption_tag, key_version, masked_preview, created_at
     ) VALUES (@id, @runId, @ws, @project, @project, @name, @name,
       @ciphertext, @iv, @tag, @keyVersion, @masked, @now)`,
    {
      id: uniqueTestId("tsec"),
      runId,
      ws,
      project,
      name,
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      tag: encrypted.tag,
      keyVersion: encrypted.keyVersion,
      masked: maskSecret(value),
      now: nowIso(),
    },
  );
}

async function insertCase(runId: string, orderIndex: number, title: string, steps: { instruction: string; expectedResult?: string }[]) {
  const caseId = uniqueTestId("tcr");
  await sqlRun(
    `INSERT INTO test_execution_case_runs (
       id, run_id, workspace_id, project_id, azure_project_id, order_index,
       source_kind, title, compiled_plan_json, compile_source, created_at, updated_at
     ) VALUES (@id, @runId, @ws, @project, @project, @orderIndex,
       'manual', @title, @plan::jsonb, 'natural_text', @now, @now)`,
    {
      id: caseId,
      runId,
      ws,
      project,
      orderIndex,
      title,
      plan: JSON.stringify({
        schemaVersion: "v2-natural",
        steps: steps.map((step) => ({ instruction: step.instruction, expectedResult: step.expectedResult ?? "" })),
      }),
      now: nowIso(),
    },
  );
  for (const [index, step] of steps.entries()) {
    await sqlRun(
      `INSERT INTO test_execution_step_runs (
         id, case_run_id, run_id, workspace_id, project_id, azure_project_id,
         order_index, action_json, created_at, updated_at
       ) VALUES (@id, @caseId, @runId, @ws, @project, @project, @orderIndex, @action::jsonb, @now, @now)`,
      {
        id: uniqueTestId("tsr"),
        caseId,
        runId,
        ws,
        project,
        orderIndex: index,
        action: JSON.stringify({ instruction: step.instruction, expectedResult: step.expectedResult ?? "" }),
        now: nowIso(),
      },
    );
  }
  return caseId;
}

function makeJob(runId: string): Job {
  const now = nowIso();
  return {
    id: uniqueTestId("job"),
    workspaceId: ws,
    projectId: project,
    jobType: TEST_EXECUTION_RUN,
    payload: { runId, projectId: project },
    dedupeKey: `test_execution:${project}`,
    status: "running",
    priority: 100,
    attempts: 1,
    maxAttempts: 1,
    lockedBy: workerId,
    lockedAt: now,
    runAfter: now,
    startedAt: now,
    finishedAt: null,
    errorMessage: null,
    progress: {},
    result: null,
    cancelRequestedAt: null,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
  } as Job;
}

function context(signal: AbortSignal) {
  return { workerId, signal, updateProgress: vi.fn(async () => undefined) };
}

describeDb("test-execution run handler (agentic)", () => {
  beforeAll(async () => {
    await seedWorkspace({ id: ws, orgUrl });
    await seedUser({ id: userId, email: `${userId}@example.com` });
    await seedProject({ workspaceId: ws, orgUrl, azureProjectId: project });
  });

  afterEach(() => {
    setTestExecutionExecutorFactoryForTests(null);
    setTestExecutionLlmProviderFactoryForTests(null);
    setExecutionArtifactStorageBackendForTests(null);
  });

  afterAll(async () => {
    await sqlRun(`DELETE FROM test_execution_runs WHERE workspace_id = @ws`, { ws });
    await sqlRun(`DELETE FROM test_environment_profiles WHERE workspace_id = @ws`, { ws });
    await cleanupFixtures({ workspaceIds: [ws], userIds: [userId] });
  });

  it("persists agent verdicts, rolls up the run, and records evidence — failed test is a completed job", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId);
    const passCase = await insertCase(runId, 0, "Passing case", [
      { instruction: "Open the dashboard", expectedResult: "Welcome banner" },
    ]);
    const failCase = await insertCase(runId, 1, "Failing case", [
      { instruction: "Save the order", expectedResult: "Confirmation toast" },
      { instruction: "Never reached" },
    ]);

    setExecutionArtifactStorageBackendForTests(fakeStorage());
    const executor = new FakeBrowserExecutor({ consoleErrors: ["TypeError: boom"] });
    setTestExecutionExecutorFactoryForTests(() => executor);
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        { decision: "act", actionType: "click", ref: "e1", elementDescription: "Dashboard link" },
        { decision: "step_passed", actualResult: "Welcome banner visible" },
        { decision: "step_failed", actualResult: "Error page instead of confirmation" },
      ]),
    );

    const job = makeJob(runId);
    const result = await runTestExecutionRunJob(job, context(new AbortController().signal));

    expect(result.outcome).toBe("failed");
    const run = await sqlGet<{ status: string; outcome: string; summary_json: { tokenUsage?: { totalTokens: number } } }>(
      `SELECT status, outcome, summary_json FROM test_execution_runs WHERE id = @runId`,
      { runId },
    );
    expect(run).toMatchObject({ status: "completed", outcome: "failed" });
    expect(run?.summary_json.tokenUsage?.totalTokens).toBe(150);

    const cases = await sqlAll<{ id: string; outcome: string }>(
      `SELECT id, outcome FROM test_execution_case_runs WHERE run_id = @runId ORDER BY order_index`,
      { runId },
    );
    expect(cases.find((c) => c.id === passCase)?.outcome).toBe("passed");
    expect(cases.find((c) => c.id === failCase)?.outcome).toBe("failed_assertion");

    const failSteps = await sqlAll<{ outcome: string; observation_json: { actualResult?: string } }>(
      `SELECT outcome, observation_json FROM test_execution_step_runs WHERE case_run_id = @caseId ORDER BY order_index`,
      { caseId: failCase },
    );
    expect(failSteps.map((s) => s.outcome)).toEqual(["failed_assertion", "not_run"]);
    expect(failSteps[0].observation_json.actualResult).toContain("Error page");

    const artifacts = await sqlAll<{ kind: string }>(
      `SELECT kind FROM test_execution_artifacts WHERE run_id = @runId`,
      { runId },
    );
    expect(artifacts.filter((a) => a.kind === "screenshot").length).toBeGreaterThanOrEqual(2);
    expect(artifacts.some((a) => a.kind === "console_log")).toBe(true);
    expect(executor.executedActions).toHaveLength(1);
    expect(executor.disposeCount).toBeGreaterThan(0);
  });

  it("keeps secret placeholders in persisted rows while the executor receives the value", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId);
    await insertSecret(runId, "PASSWORD", "hunter2-secret");
    await insertCase(runId, 0, "Login fill", [
      { instruction: "Enter {{secret:PASSWORD}} into the password field" },
    ]);
    const executor = new FakeBrowserExecutor();
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        {
          decision: "act",
          actionType: "fill",
          ref: "e2",
          elementDescription: "Password field",
          value: "{{secret:PASSWORD}}",
        },
        { decision: "step_passed", actualResult: "Field filled" },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));
    expect(result.outcome).toBe("passed");
    const executed = executor.executedActions[0];
    expect(executed.type === "fill" && executed.value).toBe("hunter2-secret");
    const stepRow = await sqlGet<{ action_json: { instruction: string }; observation_json: unknown }>(
      `SELECT action_json, observation_json FROM test_execution_step_runs WHERE run_id = @runId`,
      { runId },
    );
    expect(stepRow?.action_json.instruction).toContain("{{secret:PASSWORD}}");
    expect(JSON.stringify(stepRow?.observation_json)).not.toContain("hunter2-secret");
  });

  it("login-plan failure blocks every case as blocked_prerequisite", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, {
      ...ENV_CONFIG,
      loginPlan: {
        schemaVersion: "v2-natural",
        steps: [{ instruction: "Sign in", expectedResult: "Dashboard" }],
      },
    });
    await insertCase(runId, 0, "Case A", [{ instruction: "Do A" }]);
    await insertCase(runId, 1, "Case B", [{ instruction: "Do B" }]);

    setTestExecutionExecutorFactoryForTests(() => new FakeBrowserExecutor());
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([{ decision: "blocked", reason: "Login form rejects the credentials." }]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));
    expect(result.outcome).toBe("blocked");
    const cases = await sqlAll<{ outcome: string }>(
      `SELECT outcome FROM test_execution_case_runs WHERE run_id = @runId`,
      { runId },
    );
    expect(cases.map((c) => c.outcome)).toEqual(["blocked_prerequisite", "blocked_prerequisite"]);
  });

  it("a missing LLM provider finalizes the run as infrastructure error", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId);
    await insertCase(runId, 0, "Never runs", [{ instruction: "Do something" }]);
    setTestExecutionExecutorFactoryForTests(() => new FakeBrowserExecutor());
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () => {
      throw new Error("The run creator no longer has an LLM provider configured.");
    });

    await expect(
      runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal)),
    ).rejects.toThrow(/LLM provider/);
    const run = await sqlGet<{ status: string; outcome: string; error_message: string }>(
      `SELECT status, outcome, error_message FROM test_execution_runs WHERE id = @runId`,
      { runId },
    );
    expect(run).toMatchObject({ status: "error", outcome: "infrastructure_error" });
    expect(run?.error_message).toContain("LLM provider");
  });

  it("infrastructure failure at browser start finalizes the run as error and rethrows", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId);
    await insertCase(runId, 0, "Never runs", [{ instruction: "Do something" }]);
    setTestExecutionExecutorFactoryForTests(() => new FakeBrowserExecutor({ failStart: true }));
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () => sequencedProvider([]));

    await expect(
      runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal)),
    ).rejects.toThrow(/fake start failure/);
    const run = await sqlGet<{ status: string; outcome: string }>(
      `SELECT status, outcome FROM test_execution_runs WHERE id = @runId`,
      { runId },
    );
    expect(run).toMatchObject({ status: "error", outcome: "infrastructure_error" });
  });

  it("user cancellation finalizes the run as canceled and disposes the browser", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId);
    await insertCase(runId, 0, "First", [{ instruction: "Do first" }]);
    await insertCase(runId, 1, "Second", [{ instruction: "Do second" }]);

    // Real jobs row so isJobCancellationRequested sees the cancel flag.
    const jobId = uniqueTestId("job");
    const now = nowIso();
    await sqlRun(
      `INSERT INTO jobs (id, workspace_id, project_id, job_type, payload_json, status, priority,
                          attempts, max_attempts, locked_by, locked_at, run_after,
                          cancel_requested_at, created_at, updated_at)
       VALUES (@id, @ws, @project, @jobType, @payload, 'running', 100, 1, 1, @workerId, @now, @now,
               @now, @now, @now)`,
      {
        id: jobId,
        ws,
        project,
        jobType: TEST_EXECUTION_RUN,
        payload: JSON.stringify({ runId, projectId: project }),
        workerId,
        now,
      },
    );
    const job = { ...makeJob(runId), id: jobId };

    const controller = new AbortController();
    const executor = new FakeBrowserExecutor();
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([{ decision: "step_passed", actualResult: "done" }]),
    );
    const ctx = {
      workerId,
      signal: controller.signal,
      updateProgress: vi.fn(async (progress: Record<string, unknown>) => {
        if (progress.caseIndex === 2) controller.abort(new Error("Job cancellation requested."));
      }),
    };

    await expect(runTestExecutionRunJob(job, ctx)).rejects.toThrow();
    const run = await sqlGet<{ status: string; outcome: string }>(
      `SELECT status, outcome FROM test_execution_runs WHERE id = @runId`,
      { runId },
    );
    expect(run).toMatchObject({ status: "canceled", outcome: "canceled" });
    const cases = await sqlAll<{ outcome: string }>(
      `SELECT outcome FROM test_execution_case_runs WHERE run_id = @runId ORDER BY order_index`,
      { runId },
    );
    expect(cases[0].outcome).toBe("passed");
    expect(cases[1].outcome).toBe("not_run");
    expect(executor.disposeCount).toBeGreaterThan(0);
    await sqlRun(`DELETE FROM jobs WHERE id = @jobId`, { jobId });
  });

  it("writes from a job that does not own the run are fenced no-ops", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId);
    await insertCase(runId, 0, "Case", [{ instruction: "Do it" }]);
    setTestExecutionExecutorFactoryForTests(() => new FakeBrowserExecutor());
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([{ decision: "step_passed", actualResult: "done" }]),
    );
    await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    // A second job (stale reclaim scenario) must not be able to re-finalize.
    const staleResult = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));
    expect(staleResult.outcome).toBe("already_finalized");
  });

  // ---- login session reuse (AgentEx optimize-login) ----

  const SESSION_ENV = {
    ...ENV_CONFIG,
    loginPlan: {
      schemaVersion: "v2-natural",
      steps: [{ instruction: "Sign in", expectedResult: "Dashboard" }],
    },
    loginMode: "session",
    loggedInText: "Logout",
  };

  it("captures an encrypted session after a fresh login when the run is session-eligible", async () => {
    const profileId = uniqueTestId("tenv");
    await insertProfile(profileId);
    const runId = uniqueTestId("trun");
    await insertRun(runId, SESSION_ENV, profileId);
    await insertCase(runId, 0, "Case", [{ instruction: "Do it" }]);

    const executor = new FakeBrowserExecutor();
    executor.storageStateToCapture = '{"cookies":[{"name":"sid"}],"origins":[]}';
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        { decision: "step_passed", actualResult: "Logged in" },
        { decision: "step_passed", actualResult: "done" },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));
    expect(result.outcome).toBe("passed");
    expect(executor.startedWith?.storageStateJson).toBeUndefined();
    expect(executor.captureCount).toBe(1);
    const stored = await getEnvironmentSessionState({ workspaceId: ws, environmentProfileId: profileId });
    expect(stored?.stateJson).toBe('{"cookies":[{"name":"sid"}],"origins":[]}');
  });

  it("reuses a stored session when the landmark is on the page — login skipped, zero extra LLM calls", async () => {
    const profileId = uniqueTestId("tenv");
    await insertProfile(profileId);
    const runId = uniqueTestId("trun");
    await insertRun(runId, SESSION_ENV, profileId);
    await insertCase(runId, 0, "Case", [{ instruction: "Do it" }]);
    await saveEnvironmentSessionState({
      workspaceId: ws,
      projectId: project,
      azureProjectId: project,
      environmentProfileId: profileId,
      stateJson: '{"cookies":[{"name":"stored"}],"origins":[]}',
    });

    const executor = new FakeBrowserExecutor({ snapshots: ['- link "Logout" [ref=e9]\n- button "Save" [ref=e1]'] });
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    const provider = sequencedProvider([{ decision: "step_passed", actualResult: "done" }]);
    setTestExecutionLlmProviderFactoryForTests(async () => provider);

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));
    expect(result.outcome).toBe("passed");
    expect(executor.startedWith?.storageStateJson).toBe('{"cookies":[{"name":"stored"}],"origins":[]}');
    // Landmark verification is deterministic — the only model call is the test step itself.
    expect((provider.generateStructuredOutput as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(executor.captureCount).toBe(0);
  });

  it("falls back to a fresh login when the stored session misses the landmark, then re-captures", async () => {
    const profileId = uniqueTestId("tenv");
    await insertProfile(profileId);
    const runId = uniqueTestId("trun");
    await insertRun(runId, SESSION_ENV, profileId);
    await insertCase(runId, 0, "Case", [{ instruction: "Do it" }]);
    await saveEnvironmentSessionState({
      workspaceId: ws,
      projectId: project,
      azureProjectId: project,
      environmentProfileId: profileId,
      stateJson: '{"cookies":[{"name":"stale"}],"origins":[]}',
    });

    const executor = new FakeBrowserExecutor({ snapshots: ['- heading "Sign in" [ref=e1]'] });
    executor.storageStateToCapture = '{"cookies":[{"name":"fresh"}],"origins":[]}';
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        { decision: "step_passed", actualResult: "Logged in" },
        { decision: "step_passed", actualResult: "done" },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));
    expect(result.outcome).toBe("passed");
    expect(executor.startedWith?.storageStateJson).toBe('{"cookies":[{"name":"stale"}],"origins":[]}');
    expect(executor.captureCount).toBe(1);
    const stored = await getEnvironmentSessionState({ workspaceId: ws, environmentProfileId: profileId });
    expect(stored?.stateJson).toBe('{"cookies":[{"name":"fresh"}],"origins":[]}');
  });

  it("loginMode fresh never injects nor captures, even with a stored session", async () => {
    const profileId = uniqueTestId("tenv");
    await insertProfile(profileId);
    const runId = uniqueTestId("trun");
    await insertRun(runId, { ...SESSION_ENV, loginMode: "fresh" }, profileId);
    await insertCase(runId, 0, "Case", [{ instruction: "Do it" }]);
    await saveEnvironmentSessionState({
      workspaceId: ws,
      projectId: project,
      azureProjectId: project,
      environmentProfileId: profileId,
      stateJson: '{"cookies":[{"name":"stored"}],"origins":[]}',
    });

    const executor = new FakeBrowserExecutor();
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        { decision: "step_passed", actualResult: "Logged in" },
        { decision: "step_passed", actualResult: "done" },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));
    expect(result.outcome).toBe("passed");
    expect(executor.startedWith?.storageStateJson).toBeUndefined();
    expect(executor.captureCount).toBe(0);
    const stored = await getEnvironmentSessionState({ workspaceId: ws, environmentProfileId: profileId });
    expect(stored?.stateJson).toBe('{"cookies":[{"name":"stored"}],"origins":[]}');
  });
});
