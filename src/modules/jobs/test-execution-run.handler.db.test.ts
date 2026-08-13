import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

import { nowIso, sqlAll, sqlGet, sqlRun } from "@/modules/shared/infrastructure/database/db";
import { encryptSecret, maskSecret } from "@/modules/security/encryption.service";
import type { StorageBackend } from "@/modules/documents/storage/storage-backend.port";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { setExecutionArtifactStorageBackendForTests } from "@/modules/test-execution/artifact-storage.service";
import { FakeBrowserExecutor } from "@/modules/integrations/browser-automation/fake-browser-executor";
import type { LayerHint } from "@/modules/test-execution/action-schema";
import { configuredEnvironmentLayers } from "@/modules/test-execution/environment-layers";
import type { MultiLayerAction } from "@/modules/test-execution/multi-layer-action";
import type { MultiLayerRuntime } from "@/modules/test-execution/multi-layer-runtime.port";
import type { TestExecutionLayerRuntimeOptions } from "@/modules/test-execution/test-execution-layer-runtime";
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
  setTestExecutionLayerRuntimeFactoryForTests,
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

/**
 * Freeze one approved integration operation onto a still-queued run, exactly
 * as run creation used to before the capability catalog was removed.
 */
async function insertCapability(
  runId: string,
  input: {
    layer: "api" | "db";
    safetyClass: "read" | "mutation";
    definition: Record<string, unknown>;
    driver?: "postgres" | "sqlserver" | "mysql";
  },
) {
  const revisionId = uniqueTestId("tior");
  const now = nowIso();
  await sqlRun(
    `INSERT INTO test_integration_operation_revisions (
       id, workspace_id, project_id, azure_project_id, stable_key, display_name, revision,
       layer, source_kind, safety_class, database_driver, parameter_schema_json, definition_json,
       approval_status, approved_by, approved_at, created_by, created_at
     ) VALUES (@id, @ws, @project, @project, @stableKey, @displayName, 1,
       @layer, 'manual', @safetyClass, @driver, '{}'::jsonb, @definition::jsonb,
       'approved', @userId, @now, @userId, @now)`,
    {
      id: revisionId,
      ws,
      project,
      stableKey: revisionId.toLowerCase(),
      displayName: `${input.layer}_${input.safetyClass}_op`,
      layer: input.layer,
      safetyClass: input.safetyClass,
      driver: input.driver ?? null,
      definition: JSON.stringify(input.definition),
      userId,
      now,
    },
  );
  await sqlRun(
    `INSERT INTO test_execution_run_capabilities (
       id, run_id, workspace_id, project_id, azure_project_id, capability_kind,
       operation_revision_id, created_at
     ) VALUES (@id, @runId, @ws, @project, @project, 'operation', @revisionId, @now)`,
    { id: uniqueTestId("terc"), runId, ws, project, revisionId, now },
  );
  return revisionId;
}

type RuntimeRecorder = {
  /** Every action the guarded runtime was actually asked to perform. */
  actions: MultiLayerAction[];
  /** Options the handler derived for the run (boundary, database access, ...). */
  options: TestExecutionLayerRuntimeOptions | null;
};

/**
 * Replace the guarded multi-layer runtime with a recorder: an action reaching
 * it means the validator authorized it, so "never executed" is provable
 * without a real API/database.
 */
function recordLayerRuntime(): RuntimeRecorder {
  const recorder: RuntimeRecorder = { actions: [], options: null };
  setTestExecutionLayerRuntimeFactoryForTests((options) => {
    recorder.options = options;
    return {
      // Derived the same way the real runtime derives it, so the fake can
      // never authorize a layer the environment did not configure.
      configuredLayers: new Set(
        configuredEnvironmentLayers(options.env, { browserAvailable: Boolean(options.browser) }),
      ),
      async inspectUi() {
        return { text: "", url: null };
      },
      async execute(action: MultiLayerAction) {
        recorder.actions.push(action);
        return { status: "ok" as const, summary: `${action.type} executed.`, durationMs: 1, dbRows: [] };
      },
      async dispose() {},
    } satisfies MultiLayerRuntime;
  });
  return recorder;
}

async function insertCase(
  runId: string,
  orderIndex: number,
  title: string,
  steps: { instruction: string; expectedResult?: string; layerHint?: LayerHint }[],
) {
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
        steps: steps.map((step) => ({
          instruction: step.instruction,
          expectedResult: step.expectedResult ?? "",
          layerHint: step.layerHint,
        })),
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
        action: JSON.stringify({
          instruction: step.instruction,
          expectedResult: step.expectedResult ?? "",
          layerHint: step.layerHint,
        }),
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
    setTestExecutionLayerRuntimeFactoryForTests(null);
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

  // ---- layer-aware browser evidence ----

  /** UI target plus an API target: every step could get a screenshot, but only UI steps should. */
  const UI_AND_API_ENV = {
    ...ENV_CONFIG,
    executionPolicyVersion: "intent-v1",
    api: {
      baseUrl: "https://api.example.com/v1",
      contract: null,
      auth: { type: "none" },
      requestTimeoutMs: 30_000,
    },
  };

  it("captures failure evidence only for the step that used the UI layer", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, UI_AND_API_ENV);
    const apiCase = await insertCase(runId, 0, "API only", [
      { instruction: "Call GET /orders/42 and confirm it settled", expectedResult: "The order is settled", layerHint: "api" },
    ]);
    const uiCase = await insertCase(runId, 1, "UI case", [
      { instruction: "Open the dashboard", expectedResult: "Welcome banner", layerHint: "ui" },
    ]);

    const executor = new FakeBrowserExecutor({ consoleErrors: ["Mixed content blocked"] });
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    const recorder = recordLayerRuntime();
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        {
          decision: "act",
          actionType: "api_request",
          argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }),
        },
        { decision: "step_failed", actualResult: "The order is still pending." },
        { decision: "step_failed", actualResult: "The dashboard shows an error page." },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    expect(result.outcome).toBe("failed");
    expect(recorder.actions.map((action) => action.type)).toEqual(["api_request"]);
    const artifacts = await sqlAll<{ kind: string; case_run_id: string | null }>(
      `SELECT kind, case_run_id FROM test_execution_artifacts WHERE run_id = @runId`,
      { runId },
    );
    // The API step never drove the page, so neither the screenshot of whatever
    // page was open nor that page's console noise is evidence for it.
    expect(artifacts.filter((artifact) => artifact.case_run_id === apiCase)).toEqual([]);
    expect(
      artifacts.filter((artifact) => artifact.case_run_id === uiCase).map((artifact) => artifact.kind).sort(),
    ).toEqual(["console_log", "screenshot"]);
    expect(executor.screenshotCount).toBe(1);
  });

  it("skips the case-final screenshot for a passing case that never used the UI", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, UI_AND_API_ENV);
    const apiCase = await insertCase(runId, 0, "API only", [
      { instruction: "Call GET /orders/42 and confirm it settled", expectedResult: "The order is settled", layerHint: "api" },
    ]);
    const uiCase = await insertCase(runId, 1, "UI case", [
      { instruction: "Open the dashboard", expectedResult: "Welcome banner", layerHint: "ui" },
    ]);

    const executor = new FakeBrowserExecutor();
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    recordLayerRuntime();
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        {
          decision: "act",
          actionType: "api_request",
          argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }),
        },
        { decision: "step_passed", actualResult: "The order is settled." },
        { decision: "step_passed", actualResult: "Welcome banner visible." },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    expect(result.outcome).toBe("passed");
    const artifacts = await sqlAll<{ file_name: string; case_run_id: string | null }>(
      `SELECT file_name, case_run_id FROM test_execution_artifacts WHERE run_id = @runId`,
      { runId },
    );
    expect(artifacts.filter((artifact) => artifact.case_run_id === apiCase)).toEqual([]);
    expect(artifacts.filter((artifact) => artifact.case_run_id === uiCase)).toEqual([
      { file_name: "case-final.png", case_run_id: uiCase },
    ]);
  });

  it("still captures failure evidence when the UI action itself failed", async () => {
    // observedLayers only records layers whose action SUCCEEDED, so a failed
    // UI action leaves it empty — exactly when the screenshot matters most.
    const runId = uniqueTestId("trun");
    await insertRun(runId, UI_AND_API_ENV);
    const caseId = await insertCase(runId, 0, "UI failure", [
      { instruction: "Click Save", expectedResult: "Saved", layerHint: "auto" },
    ]);

    const executor = new FakeBrowserExecutor({
      snapshots: ['- button "Save" [ref=e1]'],
      actionScript: [
        { status: "failed", reason: "element_state", observation: { durationMs: 2, detail: "not clickable" } },
        { status: "failed", reason: "element_state", observation: { durationMs: 2, detail: "not clickable" } },
      ],
    });
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        { decision: "act", actionType: "navigate", url: "https://app.example.com/save" },
        { decision: "act", actionType: "navigate", url: "https://app.example.com/save" },
      ]),
    );

    await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    const artifacts = await sqlAll<{ file_name: string }>(
      `SELECT file_name FROM test_execution_artifacts WHERE run_id = @runId AND case_run_id = @caseId`,
      { runId, caseId },
    );
    expect(artifacts.map((artifact) => artifact.file_name)).toContain("failure.png");
  });

  it("captures failure evidence for a case that drove the browser before an API step failed", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, UI_AND_API_ENV);
    const caseId = await insertCase(runId, 0, "Mixed", [
      { instruction: "Open the dashboard", expectedResult: "Welcome banner", layerHint: "ui" },
      { instruction: "Call GET /orders/42 and confirm it settled", expectedResult: "settled", layerHint: "api" },
    ]);

    const executor = new FakeBrowserExecutor();
    setTestExecutionExecutorFactoryForTests(() => executor);
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    recordLayerRuntime();
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        { decision: "step_passed", actualResult: "Welcome banner visible." },
        {
          decision: "act",
          actionType: "api_request",
          argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }),
        },
        { decision: "step_failed", actualResult: "The order is not settled." },
      ]),
    );

    await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    const artifacts = await sqlAll<{ file_name: string }>(
      `SELECT file_name FROM test_execution_artifacts WHERE run_id = @runId AND case_run_id = @caseId`,
      { runId, caseId },
    );
    expect(artifacts.map((artifact) => artifact.file_name)).toContain("failure.png");
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

  it("threads execution notes and test-user notes into the agent prompt", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, {
      ...ENV_CONFIG,
      executionNotes: "Dates use DD/MM/YYYY.",
      users: [
        { handle: "expired_user", username: "expired@example.com", passwordSecretName: null, notes: "subscription lapsed" },
      ],
    });
    await insertCase(runId, 0, "Case", [{ instruction: "Do it" }]);

    const provider = sequencedProvider([{ decision: "step_passed", actualResult: "done" }]);
    setTestExecutionExecutorFactoryForTests(() => new FakeBrowserExecutor());
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () => provider);

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));
    expect(result.outcome).toBe("passed");
    const [promptInput] = (provider.generateStructuredOutput as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(promptInput.user).toContain("## Environment notes");
    expect(promptInput.user).toContain("Dates use DD/MM/YYYY.");
    expect(promptInput.user).toContain("subscription lapsed");
    expect(promptInput.system).toContain("Execution notes");
  });

  it("renders environment and run notes as separate sections with run-note precedence", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, {
      ...ENV_CONFIG,
      executionNotes: "Dates use DD/MM/YYYY.",
      runNotes: "Use the seeded order #4021 for this run.",
    });
    await insertCase(runId, 0, "Case", [{ instruction: "Do it" }]);

    const provider = sequencedProvider([{ decision: "step_passed", actualResult: "done" }]);
    setTestExecutionExecutorFactoryForTests(() => new FakeBrowserExecutor());
    setExecutionArtifactStorageBackendForTests(fakeStorage());
    setTestExecutionLlmProviderFactoryForTests(async () => provider);

    await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));
    const [promptInput] = (provider.generateStructuredOutput as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(promptInput.user).toContain("Dates use DD/MM/YYYY.");
    expect(promptInput.user).toContain("Use the seeded order #4021 for this run.");
    expect(promptInput.user).toContain("## Run notes");
    expect(promptInput.user).toContain("take precedence over the environment notes");
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

  // ---- execution-policy versioning (legacy-intent vs intent-v1 frozen runs) ----

  /**
   * An API+DB environment frozen BEFORE the intent-v1 policy: no
   * executionPolicyVersion stamp, and the removed tester-facing authorization
   * fields still present. The worker must re-enforce exactly this authority.
   */
  const LEGACY_ENV = {
    initialUrl: "",
    allowedOrigin: "",
    evidenceLevel: "on_failure",
    loginPlan: null as unknown,
    api: {
      baseUrl: "https://api.legacy.example/v1",
      contract: null,
      auth: { type: "none" },
      requestTimeoutMs: 30_000,
      mutationMode: "disabled",
    },
    database: {
      driver: "postgres",
      host: "db.legacy.example",
      port: 5432,
      databaseName: "qa",
      username: "itestflow",
      tlsMode: "disable",
      schemas: ["public"],
      connectTimeoutMs: 10_000,
      statementTimeoutMs: 30_000,
      accessMode: "read_only",
    },
  };

  function stepObservation(runId: string) {
    return sqlGet<{
      outcome: string;
      observation_json: { actionsTaken: { result: string; detail?: string }[] };
    }>(
      `SELECT outcome, observation_json FROM test_execution_step_runs WHERE run_id = @runId ORDER BY order_index`,
      { runId },
    );
  }

  it("re-enforces a legacy frozen run's original mutation restrictions", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, LEGACY_ENV);
    const apiMutationId = await insertCapability(runId, {
      layer: "api",
      safetyClass: "mutation",
      definition: { method: "POST", path: "/orders" },
    });
    await insertCase(runId, 0, "Legacy gated case", [
      { instruction: "Create an order", expectedResult: "The order exists" },
    ]);

    const recorder = recordLayerRuntime();
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        {
          decision: "act",
          actionType: "api_execute_operation",
          argumentsJson: JSON.stringify({ operationId: apiMutationId, parameters: {} }),
        },
        {
          decision: "act",
          actionType: "db_mutate",
          argumentsJson: JSON.stringify({
            sql: "UPDATE orders SET status = :status",
            parameters: { status: "ready" },
          }),
        },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    expect(result.outcome).toBe("needs_review");
    // Neither the frozen catalog mutation nor the new ad-hoc DML path reached
    // the runtime: the run cannot resume with authority it never had.
    expect(recorder.actions).toEqual([]);
    const step = await stepObservation(runId);
    expect(step?.outcome).toBe("needs_review");
    expect(step?.observation_json.actionsTaken.map((record) => [record.result, record.detail])).toEqual([
      ["rejected", "API mutations are disabled for this environment."],
      ["rejected", "Composing database changes is not enabled for this run; use an approved database operation."],
    ]);
    const actionRuns = await sqlAll(
      `SELECT id FROM test_execution_action_runs WHERE run_id = @runId`,
      { runId },
    );
    expect(actionRuns).toEqual([]);
  });

  it("still performs the catalog mutations a legacy run was approved with", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, {
      ...LEGACY_ENV,
      api: { ...LEGACY_ENV.api, mutationMode: "approved_catalog" },
      database: { ...LEGACY_ENV.database, accessMode: "cataloged_dml" },
    });
    const apiMutationId = await insertCapability(runId, {
      layer: "api",
      safetyClass: "mutation",
      definition: { method: "POST", path: "/orders" },
    });
    const dbMutationId = await insertCapability(runId, {
      layer: "db",
      safetyClass: "mutation",
      driver: "postgres",
      definition: { sql: "UPDATE orders SET status = :status" },
    });
    await insertCase(runId, 0, "Legacy approved case", [
      { instruction: "Create then settle an order", expectedResult: "The order is settled" },
    ]);

    const recorder = recordLayerRuntime();
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        {
          decision: "act",
          actionType: "api_execute_operation",
          argumentsJson: JSON.stringify({ operationId: apiMutationId, parameters: {} }),
        },
        {
          decision: "act",
          actionType: "db_execute_operation",
          argumentsJson: JSON.stringify({ operationId: dbMutationId, parameters: { status: "settled" } }),
        },
        { decision: "step_passed", actualResult: "Both approved operations completed." },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    expect(result.outcome).toBe("passed");
    expect(recorder.actions.map((action) => action.type)).toEqual([
      "api_execute_operation",
      "db_execute_operation",
    ]);
    // A legacy run keeps the schema allowlist it was frozen with; it never
    // gains per-table discovery, so the per-table check stays skipped.
    expect(recorder.options?.databaseAccess).toEqual({ schemas: ["public"] });
    expect(recorder.options?.databaseAccess?.tables).toBeUndefined();
    const discovery = await sqlAll(
      `SELECT run_id FROM test_execution_run_database_discovery WHERE run_id = @runId`,
      { runId },
    );
    expect(discovery).toEqual([]);
  });

  it("an intent-v1 run has no legacy gate even with the removed fields still frozen", async () => {
    const runId = uniqueTestId("trun");
    // Same shape, same (now meaningless) mutationMode/accessMode values — the
    // stamp alone decides which policy the worker enforces.
    await insertRun(runId, { ...LEGACY_ENV, executionPolicyVersion: "intent-v1" });
    const apiMutationId = await insertCapability(runId, {
      layer: "api",
      safetyClass: "mutation",
      definition: { method: "POST", path: "/orders" },
    });
    await insertCase(runId, 0, "intent-v1 case", [
      { instruction: "Create an order", expectedResult: "The order exists" },
    ]);

    const recorder = recordLayerRuntime();
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        {
          decision: "act",
          actionType: "api_execute_operation",
          argumentsJson: JSON.stringify({ operationId: apiMutationId, parameters: {} }),
        },
        {
          decision: "act",
          actionType: "db_mutate",
          argumentsJson: JSON.stringify({
            sql: "UPDATE orders SET status = :status",
            parameters: { status: "ready" },
          }),
        },
        { decision: "step_passed", actualResult: "Both actions completed." },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    expect(result.outcome).toBe("passed");
    expect(recorder.actions.map((action) => action.type)).toEqual(["api_execute_operation", "db_mutate"]);
    const step = await stepObservation(runId);
    expect(step?.observation_json.actionsTaken.map((record) => record.result)).toEqual(["ok", "ok"]);
    // intent-v1 asks the account what it can see instead of trusting the
    // frozen allowlist; with no db.password the discovery is simply recorded
    // as unavailable.
    expect(recorder.options?.databaseAccess).toBeUndefined();
    expect(await sqlGet<{ status: string; error_code: string | null }>(
      `SELECT status, error_code FROM test_execution_run_database_discovery WHERE run_id = @runId`,
      { runId },
    )).toMatchObject({ status: "failed", error_code: "missing-credential" });
  });

  it("narrows a legacy run's ad-hoc API surface to reads", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, LEGACY_ENV);
    await insertCase(runId, 0, "Legacy ad-hoc case", [
      { instruction: "Call POST /orders, then confirm with GET /orders/42", expectedResult: "The order is listed" },
    ]);

    const recorder = recordLayerRuntime();
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        {
          decision: "act",
          actionType: "api_request",
          argumentsJson: JSON.stringify({ method: "POST", path: "/orders" }),
        },
        {
          decision: "act",
          actionType: "api_request",
          argumentsJson: JSON.stringify({ method: "GET", path: "/orders/42" }),
        },
        { decision: "step_passed", actualResult: "The order is listed." },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    expect(result.outcome).toBe("passed");
    // The step text names both requests, but a legacy run may only issue the read.
    expect(recorder.actions.map((action) =>
      action.type === "api_request" ? `${action.arguments.method} ${action.arguments.path}` : action.type,
    )).toEqual(["GET /orders/42"]);
    const step = await stepObservation(runId);
    expect(step?.observation_json.actionsTaken[0]).toMatchObject({
      result: "rejected",
      detail: expect.stringContaining("only call API operations named in its frozen steps"),
    });
  });

  it("runs a legacy frozen config that still carries every removed field end to end", async () => {
    const runId = uniqueTestId("trun");
    await insertRun(runId, {
      ...LEGACY_ENV,
      api: { ...LEGACY_ENV.api, mutationMode: "approved_catalog" },
      database: {
        ...LEGACY_ENV.database,
        accessMode: "cataloged_dml",
        schemas: ["public", "billing"],
        tlsMode: "disable",
      },
    });
    await insertCase(runId, 0, "Read orders", [{ instruction: "Read the orders table", expectedResult: "Rows returned" }]);
    await insertCase(runId, 1, "Read invoices", [{ instruction: "Read the invoices table", expectedResult: "Rows returned" }]);

    const recorder = recordLayerRuntime();
    setTestExecutionLlmProviderFactoryForTests(async () =>
      sequencedProvider([
        { decision: "act", actionType: "db_select", argumentsJson: JSON.stringify({ sql: "SELECT 1", parameters: {} }) },
        { decision: "step_passed", actualResult: "Rows returned." },
        { decision: "act", actionType: "db_select", argumentsJson: JSON.stringify({ sql: "SELECT 2", parameters: {} }) },
        { decision: "step_passed", actualResult: "Rows returned." },
      ]),
    );

    const result = await runTestExecutionRunJob(makeJob(runId), context(new AbortController().signal));

    // Reaching a terminal outcome at all proves the frozen-run reader still
    // parses mutationMode/accessMode/schemas/tlsMode="disable".
    expect(result).toMatchObject({ outcome: "passed", totalCases: 2, executedCases: 2 });
    const run = await sqlGet<{ status: string; outcome: string; error_message: string | null }>(
      `SELECT status, outcome, error_message FROM test_execution_runs WHERE id = @runId`,
      { runId },
    );
    expect(run).toMatchObject({ status: "completed", outcome: "passed", error_message: null });
    expect(recorder.options?.databaseAccess).toEqual({ schemas: ["public", "billing"] });
    expect(recorder.actions.map((action) => action.type)).toEqual(["db_select", "db_select"]);
  });
});
