import "server-only";

import { NaturalPlanSchema, type NaturalPlan, type NaturalStep } from "@/modules/test-execution/action-schema";
import {
  buildRunSummary,
  rollUpCaseOutcome,
  rollUpRunOutcome,
  stepOutcomeContinuesCase,
} from "@/modules/test-execution/outcome-classifier";
import {
  runAgenticStep,
  type AgenticStepResult,
} from "@/modules/test-execution/agentic-step-executor";
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
  insertArtifactRecord,
  listCaseOutcomes,
  loadRunForExecution,
  markCaseRunning,
  markRunRunning,
  markStepRunning,
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
 * (agentic-step-executor). The optional login plan runs once up front, and
 * its failure blocks every case as blocked_prerequisite.
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
  if (bundle.run.status !== "queued" && !(bundle.run.status === "running" && bundle.run.jobId === job.id)) {
    return { outcome: "already_finalized", runId, runStatus: bundle.run.status };
  }
  if (!await markRunRunning(runId, job.id)) {
    return { outcome: "run_not_claimable", runId };
  }
  // The bundle was loaded before the claim; all fenced writes key off this.
  bundle.run.jobId = job.id;

  const scrub = createScrubber(buildScrubValues(bundle.secrets));
  const env = bundle.run.envConfig;
  const executor = createExecutor();
  const evidence = new EvidenceBudget(bundle, job.id, context.workerId);
  const llmCallBudget = { remaining: MAX_AGENT_LLM_CALLS_PER_RUN };

  // Reclaim after a shutdown requeue: a case left 'running' was interrupted
  // mid-browser-session; it cannot be resumed deterministically.
  for (const caseRun of bundle.cases.filter((entry) => entry.status === "running")) {
    await finalizeRemainingSteps(runId, job.id, caseRun.id, "infrastructure_error");
    await finalizeCase(runId, job.id, caseRun.id, "infrastructure_error", "Interrupted by a worker restart.");
  }

  try {
    const provider = await loadInitiatingUserProvider(
      bundle.run.workspaceId,
      job.createdByUserId ?? "",
    );

    // Login session reuse (optimize-login): eligible when the run came from a
    // saved profile with a login plan, session mode, and a logged-in landmark.
    const sessionEligible =
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

    const agentContext = {
      provider,
      executor,
      secrets: bundle.secrets,
      secretNames: [...bundle.secrets.keys()],
      testUsers: buildUserRoster(env, bundle.secrets),
      executionNotes: env.executionNotes,
      allowedOrigin: env.allowedOrigin,
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
    await executor.dispose().catch(() => undefined);
  }
}

type AgentContext = {
  provider: LLMProvider;
  executor: BrowserExecutor;
  secrets: ReadonlyMap<string, string>;
  secretNames: string[];
  testUsers: { handle: string; username: string; passwordPlaceholder: string | null; notes: string }[];
  executionNotes: string;
  allowedOrigin: string;
  scrub: Scrubber;
  signal: AbortSignal;
  llmCallBudget: { remaining: number };
  metadata: Record<string, string | undefined>;
};

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

async function runStep(
  agent: AgentContext,
  caseTitle: string,
  steps: readonly NaturalStep[],
  stepIndex: number,
  priorStepsSummary: readonly string[],
): Promise<AgenticStepResult> {
  const step = steps[stepIndex];
  return runAgenticStep({
    provider: agent.provider,
    executor: agent.executor,
    caseTitle,
    stepIndex,
    stepTotal: steps.length,
    instruction: step.instruction,
    expectedResult: step.expectedResult,
    priorStepsSummary,
    secretNames: agent.secretNames,
    testUsers: agent.testUsers,
    executionNotes: agent.executionNotes,
    secrets: agent.secrets,
    allowedOrigin: agent.allowedOrigin,
    scrub: agent.scrub,
    signal: agent.signal,
    llmCallBudget: agent.llmCallBudget,
    metadata: agent.metadata,
  });
}

async function executeLoginPlan(agent: AgentContext, loginPlan: NaturalPlan): Promise<ExecutionOutcome> {
  const summary: string[] = [];
  for (const [index, step] of loginPlan.steps.entries()) {
    const result = await runStep(agent, "Environment login", loginPlan.steps, index, summary);
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

    const result = await runStep(agent, caseRun.title, parsed.data.steps, stepIndex, priorStepsSummary);
    const observation = scrubDeep(
      {
        actionsTaken: result.actionsTaken,
        actualResult: result.actualResult,
        reason: result.reason,
        iterations: result.iterations,
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
      await evidence.captureFailure(agent.executor, caseRun.id, row.id);
      await finalizeRemainingSteps(runId, jobId, caseRun.id, "not_run");
      break;
    }
    priorStepsSummary.push(`${stepIndex + 1}. ${planStep.instruction} — passed`);
    if (env.evidenceLevel === "all_steps") {
      await evidence.captureScreenshot(agent.executor, caseRun.id, row.id, `step-${stepIndex + 1}.png`);
    }
  }

  const caseOutcome = rollUpCaseOutcome(stepOutcomes);
  if (caseOutcome === "passed" && env.evidenceLevel !== "minimal") {
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
