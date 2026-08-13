import "server-only";

import { NaturalPlanSchema, type NaturalPlan, type NaturalStep } from "@/modules/test-execution/action-schema";
import {
  buildRunSummary,
  rollUpCaseOutcome,
  rollUpRunOutcome,
  stepOutcomeContinuesCase,
} from "@/modules/test-execution/outcome-classifier";
import {
  runMultiLayerStep,
  type MultiLayerStepResult,
} from "@/modules/test-execution/multi-layer-step-executor";
import { CaseCaptureStore } from "@/modules/test-execution/case-capture-store";
import { extractExplicitApiRequests, readOnlyExplicitApiRequests } from "@/modules/test-execution/explicit-api-paths";
import { deriveExecutionBoundary } from "@/modules/test-execution/execution-boundary";
import { databaseAccessFromObjects } from "@/modules/test-execution/database-object-manifest";
import { ensureRunDatabaseDiscovery } from "@/modules/test-execution/run-database-discovery.service";
import type {
  DatabaseAccess,
  DiscoveredDatabaseObject,
} from "@/modules/integrations/database-automation/database-executor.port";
import { EXECUTION_POLICY_VERSION } from "@/modules/test-execution/schemas/test-execution.schemas";
import type { IntegrationCapability, LegacyExecutionPolicy } from "@/modules/test-execution/multi-layer-action";
import type { MultiLayerRuntime } from "@/modules/test-execution/multi-layer-runtime.port";
import { buildOpenApiIntegrationCapabilities } from "@/modules/test-execution/openapi-contract-normalizer";
import {
  TestExecutionLayerRuntime,
  type TestExecutionLayerRuntimeOptions,
} from "@/modules/test-execution/test-execution-layer-runtime";
import { buildScrubValues } from "@/modules/test-execution/secret-resolution";
import type { ExecutionOutcome } from "@/modules/test-execution/run-state";
import { putExecutionArtifact } from "@/modules/test-execution/artifact-storage.service";
import { generateDefectCandidatesForRun } from "@/modules/test-execution/defect-candidate.service";
import {
  finalizeCase,
  finalizePendingCases,
  finalizeRemainingSteps,
  finalizeRun,
  finalizeRunForCancellation,
  finalizeRunForInfrastructureError,
  finalizeStep,
  finalizeActionRun,
  insertArtifactRecord,
  listCaseOutcomes,
  loadRunForExecution,
  markInterruptedActionsUncertain,
  markCaseRunning,
  markRunRunning,
  markStepRunning,
  startActionRun,
  type RunExecutionBundle,
} from "@/modules/test-execution/run-persistence.service";
import { PlaywrightMcpExecutor } from "@/modules/integrations/browser-automation/playwright-mcp-executor";
import type { BrowserExecutor } from "@/modules/integrations/browser-automation/browser-executor.port";
import { createScrubber, scrubDeep, type Scrubber } from "@/modules/integrations/browser-automation/output-scrubber";
import { createId, nowIso } from "@/modules/shared/infrastructure/database/db";
import { writeAuditLog } from "@/modules/audit/audit.service";
import {
  deleteEnvironmentSession,
  getEnvironmentSessionState,
  saveEnvironmentSessionState,
} from "@/modules/test-execution/environment-profile.service";
import { resolveUserLlmConfig } from "@/modules/credentials/credential.service";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { createLLMProvider } from "@/modules/llm/llm-provider.factory";
import type { LLMProvider } from "@/modules/llm/llm-types";
import { TEST_EXECUTION_AGENT_PROMPT } from "@/modules/llm/prompts";

import { isJobCancellationRequested, type Job } from "./job-queue.service";
import type { JobHandlerContext } from "./job-handlers";

/**
 * Browser test-execution job handler — agentic runtime.
 *
 * Job lifecycle vs test outcome: a run whose tests fail is a COMPLETED job —
 * the handler returns a terminal result. Only infrastructure failures throw
 * (maxAttempts=1, so they are terminal too, with the run finalized as error).
 * Cases execute strictly sequentially in one shared authenticated browser
 * context; each natural-language step runs through the bounded agentic loop
 * (multi-layer-step-executor — the single engine; login runs the same engine
 * in its UI-only "login" mode). The optional login plan runs once up front,
 * and its failure blocks every case as blocked_prerequisite.
 */

export const MAX_ARTIFACTS_PER_RUN = 50;
export const MAX_ARTIFACT_BYTES_PER_RUN = 100 * 1024 * 1024;
export const MAX_AGENT_LLM_CALLS_PER_RUN = 400;

type ExecutorFactory = () => BrowserExecutor;
let executorFactoryOverride: ExecutorFactory | null = null;

export function setTestExecutionExecutorFactoryForTests(factory: ExecutorFactory | null): void {
  executorFactoryOverride = factory;
}

function createExecutor(): BrowserExecutor {
  return executorFactoryOverride ? executorFactoryOverride() : new PlaywrightMcpExecutor();
}

type LayerRuntimeFactory = (options: TestExecutionLayerRuntimeOptions) => MultiLayerRuntime;
let layerRuntimeFactoryOverride: LayerRuntimeFactory | null = null;

/** Test seam for API/DB-only handler tests; production always uses the guarded runtime. */
export function setTestExecutionLayerRuntimeFactoryForTests(factory: LayerRuntimeFactory | null): void {
  layerRuntimeFactoryOverride = factory;
}

function createLayerRuntime(options: TestExecutionLayerRuntimeOptions): MultiLayerRuntime {
  return layerRuntimeFactoryOverride ? layerRuntimeFactoryOverride(options) : new TestExecutionLayerRuntime(options);
}

type ProviderFactory = (workspaceId: string, userId: string) => Promise<LLMProvider>;
let providerFactoryOverride: ProviderFactory | null = null;

export function setTestExecutionLlmProviderFactoryForTests(factory: ProviderFactory | null): void {
  providerFactoryOverride = factory;
}

/** Same pattern as the knowledge handler: the run creator's own provider. */
async function loadInitiatingUserProvider(workspaceId: string, userId: string): Promise<LLMProvider> {
  if (providerFactoryOverride) return providerFactoryOverride(workspaceId, userId);
  const config = await resolveUserLlmConfig(workspaceId, userId);
  if (!config) {
    throw new Error("The run creator no longer has an LLM provider configured.");
  }
  const settings = await getWorkspaceSettings(workspaceId);
  return createLLMProvider({
    ...config,
    maxInputTokens: settings?.modelInputTokenLimitOverride ?? undefined,
    maxOutputTokenCap: settings?.maxOutputTokenCap ?? undefined,
    retryAttempts: settings?.llmRetryAttempts ?? undefined,
  });
}

export async function runTestExecutionRunJob(
  job: Job,
  context: JobHandlerContext,
): Promise<Record<string, unknown>> {
  const runId = typeof job.payload.runId === "string" ? job.payload.runId : null;
  if (!runId) return { outcome: "missing_run" };

  const bundle = await loadRunForExecution(runId);
  if (!bundle) return { outcome: "missing_run", runId };
  const reclaimingRun = bundle.run.status === "running";
  if (bundle.run.status !== "queued" && !(bundle.run.status === "running" && bundle.run.jobId === job.id)) {
    return { outcome: "already_finalized", runId, runStatus: bundle.run.status };
  }
  if (!await markRunRunning(runId, job.id)) {
    return { outcome: "run_not_claimable", runId };
  }
  // The bundle was loaded before the claim; all fenced writes key off this.
  bundle.run.jobId = job.id;

  const env = bundle.run.envConfig;
  const allSecretValues = new Map<string, string>([
    ...bundle.secrets,
    ...bundle.connectionSecrets,
  ]);
  const scrub = createScrubber(buildScrubValues(allSecretValues));
  const executor = env.initialUrl ? createExecutor() : null;
  let layerRuntime: MultiLayerRuntime | null = null;
  const evidence = new EvidenceBudget(bundle, job.id, context.workerId);
  const llmCallBudget = { remaining: MAX_AGENT_LLM_CALLS_PER_RUN };

  // Reclaim after a shutdown requeue. Any external action whose terminal
  // observation was not durably recorded is uncertain and must never replay.
  await markInterruptedActionsUncertain(runId, job.id);
  for (const caseRun of bundle.cases.filter((entry) => entry.status === "running")) {
    await finalizeRemainingSteps(runId, job.id, caseRun.id, "infrastructure_error");
    await finalizeCase(runId, job.id, caseRun.id, "infrastructure_error", "Interrupted by a worker restart.");
  }

  try {
    const provider = await loadInitiatingUserProvider(
      bundle.run.workspaceId,
      job.createdByUserId ?? "",
    );

    // Login session reuse applies only to environments with a UI target.
    const sessionEligible =
      Boolean(executor) &&
      Boolean(bundle.run.environmentProfileId) &&
      env.loginMode === "session" &&
      Boolean(env.loginPlan) &&
      env.loggedInText.trim().length > 0;
    let injectedState: string | undefined;
    if (sessionEligible) {
      const stored = await getEnvironmentSessionState({
        workspaceId: bundle.run.workspaceId,
        environmentProfileId: bundle.run.environmentProfileId as string,
      });
      injectedState = stored?.stateJson;
    }

    if (executor) {
      await executor.start({
        runId,
        initialUrl: env.initialUrl,
        allowedOrigin: env.allowedOrigin,
        viewport: { width: env.viewportWidth, height: env.viewportHeight },
        headless: env.headless,
        defaultTimeoutMs: env.defaultTimeoutMs,
        navigationTimeoutMs: env.navigationTimeoutMs,
        secrets: bundle.secrets,
        storageStateJson: injectedState,
        signal: context.signal,
      });
    }

    // The execution boundary is a pure function of the frozen environment
    // config: derived once per run and enforced inside the guarded executors
    // on every hop. The assertTarget options remain test-only seams.
    const boundary = deriveExecutionBoundary(env);
    // Legacy-intent runs keep the schema allowlist they were approved with;
    // intent-v1 runs ask the account what it can actually see.
    const legacyPolicy = legacyExecutionPolicyFor(env);
    const databaseAccess = await resolveDatabaseAccess({
      bundle,
      env,
      boundary,
      legacy: Boolean(legacyPolicy),
      signal: context.signal,
    });
    layerRuntime = createLayerRuntime({
      boundary,
      env,
      browser: executor,
      connectionSecrets: bundle.connectionSecrets,
      signal: context.signal,
      databaseAccess: databaseAccess.access,
    });

    const agentContext = {
      provider,
      executor,
      runtime: layerRuntime,
      capabilities: buildCapabilities(bundle),
      secrets: bundle.secrets,
      secretNames: [...bundle.secrets.keys()],
      secretTitles: bundle.secretTitles,
      testUsers: buildUserRoster(env, bundle.secrets),
      executionNotes: env.executionNotes,
      runNotes: env.runNotes,
      allowedOrigin: env.allowedOrigin,
      legacyPolicy,
      databaseObjects: databaseAccess.objects,
      scrub,
      signal: context.signal,
      llmCallBudget,
      metadata: {
        action: "test_execution.agent_step",
        promptName: TEST_EXECUTION_AGENT_PROMPT.name,
        promptVersion: TEST_EXECUTION_AGENT_PROMPT.version,
        projectId: bundle.run.projectId,
        azureProjectId: bundle.run.azureProjectId,
      },
    };

    if (env.loginPlan) {
      if (!executor) throw new Error("The environment has a login plan but no UI target.");
      let loginNeeded = true;
      // Landmark verification: deterministic, zero LLM calls — the injected
      // session counts only if the authenticated-only text is on the page.
      if (injectedState) {
        const snapshot = await executor.takeSnapshot();
        if (snapshot.text.toLowerCase().includes(env.loggedInText.trim().toLowerCase())) {
          loginNeeded = false;
          sessionAudit(bundle, runId, "test_execution.session_reused", "Reused the saved login session (landmark verified).");
        } else {
          sessionAudit(bundle, runId, "test_execution.session_stale", "Saved login session was stale; falling back to a fresh login.");
          await deleteEnvironmentSession({
            workspaceId: bundle.run.workspaceId,
            environmentProfileId: bundle.run.environmentProfileId as string,
          }).catch(() => undefined);
        }
      }

      if (loginNeeded) {
        // Login actions do not have case/step rows to anchor an action-ledger
        // record. After a worker loss, never (re)play a possibly effectful
        // login submit/OTP action — but only when a login would actually run:
        // a landmark-verified saved session lets the reclaimed run continue
        // its remaining cases without touching the login flow.
        if (reclaimingRun) {
          throw new Error("A worker restart interrupted a run with a login prerequisite; the login sequence was not replayed.");
        }
        const loginOutcome = await executeLoginPlan(agentContext, env.loginPlan);
        if (loginOutcome !== "passed") {
          await evidence.captureFailure(executor, null, null);
          await finalizePendingCases(runId, job.id, "blocked_prerequisite");
          return await finalizeAndSummarize(runId, job.id, provider, { loginOutcome });
        }
        if (sessionEligible && !context.signal.aborted) {
          const capturedState = await executor.captureStorageState();
          if (capturedState) {
            await saveEnvironmentSessionState({
              workspaceId: bundle.run.workspaceId,
              projectId: bundle.run.projectId,
              azureProjectId: bundle.run.azureProjectId,
              environmentProfileId: bundle.run.environmentProfileId as string,
              stateJson: capturedState,
            }).catch(() => undefined);
            sessionAudit(bundle, runId, "test_execution.session_captured", "Captured an encrypted login session for reuse.");
          }
        }
      }
    }

    const pendingCases = bundle.cases.filter((entry) => entry.status === "pending");
    const caseTotal = bundle.cases.length;
    for (const [index, caseRun] of pendingCases.entries()) {
      if (context.signal.aborted) throw new Error("Execution aborted.");
      await context.updateProgress({
        phase: "executing",
        percent: Math.round(((index + 1) / Math.max(1, pendingCases.length)) * 100),
        runId,
        caseIndex: index + 1,
        caseTotal,
        caseTitle: caseRun.title.slice(0, 120),
      });
      // The cancel poll can abort while progress is being written; a case
      // that has not started must stay pending (→ not_run), not in-flight.
      if (context.signal.aborted) throw new Error("Execution aborted.");
      if (!await markCaseRunning(runId, job.id, caseRun.id)) {
        throw new Error("The worker no longer owns this run.");
      }
      await executeCase(agentContext, bundle, caseRun, evidence, context);
    }

    if (context.signal.aborted) throw new Error("Execution aborted.");
    await finalizePendingCases(runId, job.id, "not_run");
    return await finalizeAndSummarize(runId, job.id, provider, {});
  } catch (error) {
    if (context.signal.aborted) {
      // User cancellation finalizes the run; a shutdown requeue must leave the
      // rows untouched so the reclaiming worker can resume remaining cases.
      if (await isJobCancellationRequested(job.id, context.workerId)) {
        await finalizeRunForCancellation(runId, job.id);
        writeAuditLog({
          workspaceId: bundle.run.workspaceId,
          projectId: bundle.run.projectId,
          azureProjectId: bundle.run.azureProjectId,
          entityType: "test_execution_run",
          entityId: runId,
          action: "test_execution.run_canceled",
          status: "Info",
          actor: "worker",
          message: "Test execution run canceled by user request.",
        });
      }
      throw error;
    }
    const message = scrub(error instanceof Error ? error.message : "Test execution failed.").slice(0, 1_000);
    await finalizeRunForInfrastructureError(runId, job.id, message);
    writeAuditLog({
      workspaceId: bundle.run.workspaceId,
      projectId: bundle.run.projectId,
      azureProjectId: bundle.run.azureProjectId,
      entityType: "test_execution_run",
      entityId: runId,
      action: "test_execution.run_failed",
      status: "Failed",
      actor: "worker",
      message: `Test execution run failed: ${message}`,
    });
    throw error;
  } finally {
    await layerRuntime?.dispose().catch(() => undefined);
    await executor?.dispose().catch(() => undefined);
  }
}

type AgentContext = {
  provider: LLMProvider;
  executor: BrowserExecutor | null;
  runtime: MultiLayerRuntime;
  capabilities: IntegrationCapability[];
  secrets: ReadonlyMap<string, string>;
  secretNames: string[];
  secretTitles: ReadonlyMap<string, string>;
  testUsers: { handle: string; username: string; passwordPlaceholder: string | null; notes: string }[];
  executionNotes: string;
  /** Per-run guidance frozen at approval; wins over environment notes. */
  runNotes: string;
  allowedOrigin: string;
  /** Present only for runs frozen before intent-v1 (see legacyExecutionPolicyFor). */
  legacyPolicy?: LegacyExecutionPolicy;
  /** Discovered database objects offered to the agent, ranked per step. */
  databaseObjects: DiscoveredDatabaseObject[];
  scrub: Scrubber;
  signal: AbortSignal;
  llmCallBudget: { remaining: number };
  metadata: Record<string, string | undefined>;
};

/**
 * A frozen run without an executionPolicyVersion stamp was approved under the
 * pre-simplification model: its mutation gates (and read-only ad-hoc API
 * surface — see explicitApiRequestsFor) are re-enforced exactly as approved,
 * so a queued pre-deploy run can never resume with broader authority.
 */
function legacyExecutionPolicyFor(
  env: RunExecutionBundle["run"]["envConfig"],
): LegacyExecutionPolicy | undefined {
  if (env.executionPolicyVersion === EXECUTION_POLICY_VERSION) return undefined;
  return {
    apiMutationsEnabled: env.api?.mutationMode === "approved_catalog",
    databaseDmlEnabled: env.database?.accessMode === "cataloged_dml",
  };
}

/** Explicit "METHOD /path" tokens from the frozen step text and notes. */
function explicitApiRequestsFor(
  agent: AgentContext,
  planStep: { instruction: string; expectedResult: string },
): Set<string> {
  const requests = extractExplicitApiRequests(
    planStep.instruction,
    planStep.expectedResult,
    agent.executionNotes,
    agent.runNotes,
  );
  return agent.legacyPolicy ? readOnlyExplicitApiRequests(requests) : requests;
}

/**
 * intent-v1 runs derive their database surface from what the account can see;
 * legacy-intent runs keep the frozen schema allowlist they were approved with
 * (and never gain the discovered-object manifest).
 */
async function resolveDatabaseAccess(input: {
  bundle: RunExecutionBundle;
  env: RunExecutionBundle["run"]["envConfig"];
  boundary: ReturnType<typeof deriveExecutionBoundary>;
  legacy: boolean;
  signal: AbortSignal;
}): Promise<{ access?: DatabaseAccess; objects: DiscoveredDatabaseObject[] }> {
  const database = input.env.database;
  if (!database) return { objects: [] };
  if (input.legacy) {
    // Legacy runs had no per-table discovery: the schema allowlist alone
    // bounded them, so `tables` stays unset to preserve that exact authority.
    return { access: { schemas: database.schemas ?? [] }, objects: [] };
  }
  const discovery = await ensureRunDatabaseDiscovery({
    bundle: input.bundle,
    env: input.env,
    boundary: input.boundary,
    signal: input.signal,
  });
  if (!discovery.available) return { objects: [] };
  return { access: databaseAccessFromObjects(discovery.objects), objects: discovery.objects };
}

/**
 * Named test users for the agent prompt: handle + username + the PASSWORD
 * PLACEHOLDER (never a value). A user without its own password secret falls
 * back to DEFAULT_PASSWORD when the environment defines one.
 */
function buildUserRoster(
  env: RunExecutionBundle["run"]["envConfig"],
  secrets: ReadonlyMap<string, string>,
): AgentContext["testUsers"] {
  return env.users.map((user) => {
    const secretName =
      user.passwordSecretName && secrets.has(user.passwordSecretName)
        ? user.passwordSecretName
        : secrets.has("DEFAULT_PASSWORD")
          ? "DEFAULT_PASSWORD"
          : null;
    return {
      handle: user.handle,
      username: user.username,
      passwordPlaceholder: secretName ? `{{secret:${secretName}}}` : null,
      notes: user.notes,
    };
  });
}

/** The run contains immutable, approved revisions pinned at approval time. */
function buildCapabilities(bundle: RunExecutionBundle): IntegrationCapability[] {
  const approvedOperations = bundle.capabilities.map((capability) => ({
    id: capability.id,
    name: capability.displayName,
    layer: capability.layer,
    safetyClass: capability.safetyClass,
    approved: true,
    driver: capability.databaseDriver ?? undefined,
    parameterSchema: capability.parameterSchema,
    definition: capability.definition,
  }));
  const contractReads = bundle.apiContracts.flatMap((contract) =>
    buildOpenApiIntegrationCapabilities(contract.id, contract.normalizedSpec),
  );
  return [...approvedOperations, ...contractReads];
}

function sessionAudit(
  bundle: RunExecutionBundle,
  runId: string,
  action: string,
  message: string,
): void {
  writeAuditLog({
    workspaceId: bundle.run.workspaceId,
    projectId: bundle.run.projectId,
    azureProjectId: bundle.run.azureProjectId,
    entityType: "test_environment_profile",
    entityId: bundle.run.environmentProfileId ?? undefined,
    action,
    status: "Info",
    actor: "worker",
    message,
    details: { runId },
  });
}

/**
 * Run one login-plan step through the unified engine in login mode: UI-only
 * layers, no capabilities, no persistence rows — the same validated loop the
 * test steps use, so prompt/validator semantics can never drift again (V7-3).
 */
async function runLoginStep(
  agent: AgentContext,
  steps: readonly NaturalStep[],
  stepIndex: number,
  priorStepsSummary: readonly string[],
): Promise<MultiLayerStepResult> {
  if (!agent.executor) throw new Error("UI is not configured for the environment login plan.");
  const step = steps[stepIndex];
  return runMultiLayerStep({
    provider: agent.provider,
    runtime: agent.runtime,
    mode: "login",
    caseTitle: "Environment login",
    stepIndex,
    stepTotal: steps.length,
    instruction: step.instruction,
    expectedResult: step.expectedResult,
    layerHint: "ui",
    priorStepsSummary,
    executionNotes: agent.executionNotes,
    runNotes: agent.runNotes,
    secretNames: agent.secretNames,
    secretTitles: agent.secretTitles,
    testUsers: agent.testUsers,
    secrets: agent.secrets,
    allowedOrigin: agent.allowedOrigin || undefined,
    allowedApiRequests: new Set<string>(),
    capabilities: [],
    legacyPolicy: agent.legacyPolicy,
    captures: new CaseCaptureStore(),
    scrub: agent.scrub,
    signal: agent.signal,
    llmCallBudget: agent.llmCallBudget,
    metadata: agent.metadata,
  });
}

async function executeLoginPlan(agent: AgentContext, loginPlan: NaturalPlan): Promise<ExecutionOutcome> {
  const summary: string[] = [];
  for (const [index, step] of loginPlan.steps.entries()) {
    const result = await runLoginStep(agent, loginPlan.steps, index, summary);
    if (result.outcome !== "passed") {
      return result.outcome === "needs_review" ? "blocked_prerequisite" : result.outcome;
    }
    summary.push(`${index + 1}. ${step.instruction} — passed`);
  }
  return "passed";
}

async function executeCase(
  agent: AgentContext,
  bundle: RunExecutionBundle,
  caseRun: RunExecutionBundle["cases"][number],
  evidence: EvidenceBudget,
  context: JobHandlerContext,
): Promise<void> {
  const runId = bundle.run.id;
  const jobId = bundle.run.jobId as string;
  const env = bundle.run.envConfig;

  const parsed = NaturalPlanSchema.safeParse(caseRun.compiledPlanJson);
  if (!parsed.success) {
    await finalizeRemainingSteps(runId, jobId, caseRun.id, "not_run");
    await finalizeCase(runId, jobId, caseRun.id, "infrastructure_error", "Stored plan failed schema validation.");
    return;
  }

  const stepRows = bundle.steps.get(caseRun.id) ?? [];
  const stepOutcomes: ExecutionOutcome[] = [];
  const priorStepsSummary: string[] = [];
  const captures = new CaseCaptureStore();

  for (const [stepIndex, planStep] of parsed.data.steps.entries()) {
    if (agent.signal.aborted) throw new Error("Execution aborted.");
    const row = stepRows[stepIndex];
    if (!row) break;
    await markStepRunning(runId, jobId, row.id);
    await context.updateProgress({
      phase: "executing",
      runId,
      caseTitle: caseRun.title.slice(0, 120),
      stepIndex: stepIndex + 1,
      stepTotal: parsed.data.steps.length,
    });

    const result: MultiLayerStepResult = await runMultiLayerStep({
      provider: agent.provider,
      runtime: agent.runtime,
      caseTitle: caseRun.title,
      stepIndex,
      stepTotal: parsed.data.steps.length,
      instruction: planStep.instruction,
      expectedResult: planStep.expectedResult,
      layerHint: planStep.layerHint,
      priorStepsSummary,
      executionNotes: agent.executionNotes,
      runNotes: agent.runNotes,
      secretNames: agent.secretNames,
      secretTitles: agent.secretTitles,
      testUsers: agent.testUsers,
      secrets: agent.secrets,
      allowedOrigin: agent.allowedOrigin || undefined,
      allowedApiRequests: explicitApiRequestsFor(agent, planStep),
      capabilities: agent.capabilities,
      databaseObjects: agent.databaseObjects,
      legacyPolicy: agent.legacyPolicy,
      databaseDriver: env.database?.driver,
      captures,
      persist: {
        start: (input) => startActionRun({
          ...input,
          runId,
          jobId,
          workspaceId: bundle.run.workspaceId,
          projectId: bundle.run.projectId,
          azureProjectId: bundle.run.azureProjectId,
          caseRunId: caseRun.id,
          stepRunId: row.id,
        }),
        finish: (input) => finalizeActionRun({ runId, jobId, ...input }),
      },
      scrub: agent.scrub,
      signal: agent.signal,
      llmCallBudget: agent.llmCallBudget,
      metadata: agent.metadata,
    });
    const observation = scrubDeep(
      {
        actionsTaken: result.actionsTaken,
        actualResult: result.actualResult,
        reason: result.reason,
        iterations: result.iterations,
        observedLayers: result.observedLayers,
        captures: captures.persistable(),
        expectedResult: planStep.expectedResult,
      },
      agent.scrub,
    );
    const errorMessage =
      result.outcome === "passed"
        ? undefined
        : (result.reason ?? result.actualResult ?? `Step ${result.outcome.replace(/_/g, " ")}.`).slice(0, 500);
    await finalizeStep(runId, jobId, row.id, result.outcome, observation as Record<string, unknown>, errorMessage);
    stepOutcomes.push(result.outcome);

    if (!stepOutcomeContinuesCase(result.outcome)) {
      if (agent.executor) await evidence.captureFailure(agent.executor, caseRun.id, row.id);
      await finalizeRemainingSteps(runId, jobId, caseRun.id, "not_run");
      break;
    }
    priorStepsSummary.push(`${stepIndex + 1}. ${planStep.instruction} — passed`);
    if (env.evidenceLevel === "all_steps" && agent.executor) {
      await evidence.captureScreenshot(agent.executor, caseRun.id, row.id, `step-${stepIndex + 1}.png`);
    }
  }

  const caseOutcome = rollUpCaseOutcome(stepOutcomes);
  if (caseOutcome === "passed" && env.evidenceLevel !== "minimal" && agent.executor) {
    await evidence.captureScreenshot(agent.executor, caseRun.id, null, "case-final.png");
  }
  await finalizeCase(runId, jobId, caseRun.id, caseOutcome);
}

async function finalizeAndSummarize(
  runId: string,
  jobId: string,
  provider: LLMProvider,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const caseOutcomes = await listCaseOutcomes(runId);
  const runOutcome = rollUpRunOutcome(caseOutcomes);
  const summary = buildRunSummary(caseOutcomes);
  await finalizeRun(runId, jobId, "completed", runOutcome, {
    caseCounts: summary.caseCounts,
    totalCases: summary.totalCases,
    executedCases: summary.executedCases,
    agentPromptVersion: TEST_EXECUTION_AGENT_PROMPT.version,
    tokenUsage: provider.getTokenUsage(),
    finalizedAt: nowIso(),
  });
  // Defect candidates are best-effort: their generation must never turn a
  // finalized run into a failed job.
  try {
    await generateDefectCandidatesForRun(runId);
  } catch (error) {
    console.error(`[test-execution] defect candidate generation failed for ${runId}`, error);
  }
  return {
    outcome: runOutcome,
    runId,
    totalCases: summary.totalCases,
    executedCases: summary.executedCases,
    ...extra,
  };
}

/** Evidence capture with per-run caps; every failure is best-effort. */
class EvidenceBudget {
  private artifactCount = 0;
  private artifactBytes = 0;

  constructor(
    private readonly bundle: RunExecutionBundle,
    private readonly jobId: string,
    private readonly workerId: string,
  ) {}

  private withinBudget(byteSize: number): boolean {
    return (
      this.artifactCount < MAX_ARTIFACTS_PER_RUN &&
      this.artifactBytes + byteSize <= MAX_ARTIFACT_BYTES_PER_RUN
    );
  }

  async captureScreenshot(
    executor: BrowserExecutor,
    caseRunId: string | null,
    stepRunId: string | null,
    fileName: string,
  ): Promise<void> {
    try {
      const shot = await executor.captureScreenshot();
      await this.store("screenshot", shot.bytes, shot.mimeType, fileName, caseRunId, stepRunId);
    } catch {
      // Evidence is best-effort; a screenshot failure must not fail the test.
    }
  }

  async captureFailure(
    executor: BrowserExecutor,
    caseRunId: string | null,
    stepRunId: string | null,
  ): Promise<void> {
    await this.captureScreenshot(executor, caseRunId, stepRunId, "failure.png");
    try {
      const consoleErrors = await executor.drainConsoleErrors();
      if (consoleErrors.length > 0) {
        await this.store(
          "console_log",
          Buffer.from(consoleErrors.join("\n"), "utf8"),
          "text/plain",
          "console-errors.log",
          caseRunId,
          stepRunId,
        );
      }
    } catch {
      // best-effort
    }
  }

  private async store(
    kind: "screenshot" | "console_log",
    bytes: Buffer,
    mimeType: string,
    fileName: string,
    caseRunId: string | null,
    stepRunId: string | null,
  ): Promise<void> {
    if (!this.withinBudget(bytes.length)) return;
    const stored = await putExecutionArtifact({ workspaceId: this.bundle.run.workspaceId, bytes });
    const inserted = await insertArtifactRecord({
      id: createId("tart"),
      runId: this.bundle.run.id,
      jobId: this.jobId,
      workspaceId: this.bundle.run.workspaceId,
      projectId: this.bundle.run.projectId,
      azureProjectId: this.bundle.run.azureProjectId,
      caseRunId,
      stepRunId,
      kind,
      storageKey: stored.storageKey,
      contentSha256: stored.contentSha256,
      mimeType,
      byteSize: stored.byteSize,
      fileName,
      createdByWorker: this.workerId,
    });
    if (inserted) {
      this.artifactCount += 1;
      this.artifactBytes += stored.byteSize;
    }
  }
}
