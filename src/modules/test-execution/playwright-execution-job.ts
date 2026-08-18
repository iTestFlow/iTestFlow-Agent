import "server-only";

import { resolveUserAzurePat, resolveUserLlmConfig } from "@/modules/credentials/credential.service";
import { createIntegrationProvider, resolveWorkspaceProviderId } from "@/modules/integrations/provider-registry";
import type { JobHandler } from "@/modules/jobs/job-handlers";
import { DEFAULT_RETRY_ATTEMPTS, getMaxOutputTokenCapDefaultFromEnv } from "@/modules/llm/llm-defaults";
import { createLLMProvider } from "@/modules/llm/llm-provider.factory";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getWorkspaceById } from "@/modules/workspace/workspace.service";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import {
  casesForRun, executionConfigSnapshot, executionRunSettings, finishCase, finishRun, finishStep, incrementCompletedCases, isRunCancellationRequested,
  markCaseStarted, markRunStarted, recordStepToolCall, stepsForCase,
} from "./execution-store.service";
import { decryptedRunTestData } from "./execution-test-data.service";
import { DEFAULT_SCREENSHOT_POLICY, shouldCaptureScreenshot } from "./screenshot-policy";
import { createPlaywrightToolPolicy, executeTestStepWithAgent, validatePlaywrightToolArguments, type ExecutionOutcome } from "./playwright-agent";
import { connectPlaywrightMcp } from "./playwright-mcp-client";
import { resolvePlaywrightMcpConfig } from "./playwright-mcp-config.service";
import { artifactUrls, importHttpArtifact, importInlineMcpArtifacts } from "./execution-artifact.service";

type Payload = { runId: string; userId: string; scope: ProjectScope };

function parsePayload(payload: Record<string, unknown>): Payload {
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const userId = typeof payload.userId === "string" ? payload.userId : "";
  const scope = payload.scope as ProjectScope | undefined;
  if (!runId || !userId || !scope?.projectId || !scope.azureProjectId) throw new Error("Invalid Playwright execution job payload.");
  return { runId, userId, scope };
}

function combineOutcomes(outcomes: ExecutionOutcome[]): ExecutionOutcome {
  for (const value of ["error", "timeout", "failed", "blocked", "cancelled"] as const) {
    if (outcomes.includes(value)) return value;
  }
  return "passed";
}

export const runPlaywrightExecutionJob: JobHandler = async (job, context) => {
  const payload = parsePayload(job.payload);
  try {
  await markRunStarted(payload.runId);
  const workspace = await getWorkspaceById(job.workspaceId ?? "");
  if (!workspace) throw new Error("Execution workspace no longer exists.");
  const [pat, llmConfig, workspaceSettings, mcpConfig] = await Promise.all([
    resolveUserAzurePat(workspace.id, payload.userId),
    resolveUserLlmConfig(workspace.id, payload.userId),
    getWorkspaceSettings(workspace.id),
    resolvePlaywrightMcpConfig(workspace.id),
  ]);
  if (!pat) throw new Error("The requesting user's Azure DevOps PAT is no longer configured.");
  if (!llmConfig) throw new Error("The requesting user's LLM credentials are no longer configured.");
  if (!mcpConfig || mcpConfig.status !== "configured") throw new Error("Playwright MCP is no longer configured and enabled.");
  const toolPolicy = createPlaywrightToolPolicy(mcpConfig.transport!);
  const snapshot = await executionConfigSnapshot(payload.runId);
  // Field-by-field, never stringify equality: jsonb round-trips reorder object keys.
  const snapshotMatchesLiveConfig = Boolean(snapshot)
    && snapshot!.transport === mcpConfig.transport
    && (snapshot!.endpoint ?? null) === (mcpConfig.endpoint ?? null)
    && (snapshot!.artifactBaseUrl ?? null) === (mcpConfig.artifactBaseUrl ?? null);
  if (!snapshotMatchesLiveConfig) {
    throw new Error("Playwright MCP configuration changed after this run was queued. Start a new execution.");
  }
  const providerId = resolveWorkspaceProviderId(workspace);
  if (providerId !== "azure-devops") throw new Error("Playwright execution currently requires an Azure DevOps workspace.");
  const settings = await executionRunSettings(payload.runId);
  const screenshotPolicy = settings?.screenshotPolicy ?? DEFAULT_SCREENSHOT_POLICY;
  const runTestData = await decryptedRunTestData(payload.runId);
  const secretValues = runTestData.filter((entry) => entry.isSecret).map((entry) => entry.value).filter(Boolean);
  const runContext = {
    baseUrl: settings?.baseUrl ?? null,
    executionNotes: settings?.executionNotes ?? null,
    testData: runTestData.map((entry) => ({ title: entry.title, value: entry.value })),
  };
  const azure = createIntegrationProvider({
    providerId,
    settings: { organizationUrl: workspace.azureOrgUrl, personalAccessToken: pat },
    projectScope: { azureProjectId: payload.scope.azureProjectId, azureProjectName: payload.scope.azureProjectName },
  });
  await azure.testConnection();
  const llm = createLLMProvider({
    ...llmConfig,
    maxInputTokens: workspaceSettings?.modelInputTokenLimitOverride ?? undefined,
    maxOutputTokenCap: workspaceSettings?.maxOutputTokenCap ?? getMaxOutputTokenCapDefaultFromEnv(),
    retryAttempts: workspaceSettings?.llmRetryAttempts ?? DEFAULT_RETRY_ATTEMPTS,
  });
  const outcomes: ExecutionOutcome[] = [];
    const cases = await casesForRun(payload.runId);
    for (const [caseIndex, testCase] of cases.entries()) {
      if (!["queued", "running"].includes(testCase.status)) {
        outcomes.push(testCase.status as ExecutionOutcome);
        continue;
      }
      if (context.signal.aborted || await isRunCancellationRequested(payload.runId)) { outcomes.push("cancelled"); break; }
      await markCaseStarted(testCase.id);
      await context.updateProgress({ phase: "executing", caseIndex, totalCases: cases.length, testCaseId: testCase.azureTestCaseId });
      let outcome: ExecutionOutcome = "passed";
      let errorMessage: string | null = null;
      let connection;
      try {
        connection = await connectPlaywrightMcp(mcpConfig, { headless: settings?.headless ?? true });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : "Playwright MCP connection failed.";
        await finishCase(testCase.id, "error", errorMessage, secretValues);
        await incrementCompletedCases(payload.runId);
        outcomes.push("error");
        continue;
      }
      try {
        const captureStepScreenshot = async (stepId: string) => {
          try {
            const result = await connection.tools.callTool("browser_take_screenshot", {}, context.signal);
            await importInlineMcpArtifacts({ workspaceId: workspace.id, runId: payload.runId, caseId: testCase.id, stepId, toolName: "browser_take_screenshot", result, secrets: secretValues });
          } catch {
            // Evidence capture is best-effort and must never change the step outcome.
          }
        };
        const steps = await stepsForCase(testCase.id);
        if (!steps.length) { outcome = "blocked"; errorMessage = "Azure Test Case has no executable steps."; }
        let baseNavigationFailed = false;
        if (settings?.baseUrl && steps.length) {
          try {
            const navigateArgs = await validatePlaywrightToolArguments("browser_navigate", { url: settings.baseUrl }, toolPolicy);
            await connection.tools.callTool("browser_navigate", navigateArgs, context.signal);
          } catch (error) {
            outcome = context.signal.aborted ? "cancelled" : "error";
            errorMessage = error instanceof Error && /allowed origin/i.test(error.message)
              ? "The Base URL is not on an allowed test origin for this deployment."
              : "The browser could not open the Base URL before the first step.";
            baseNavigationFailed = true;
          }
        }
        if (!baseNavigationFailed && settings?.baseUrl && steps.length) {
          // After the base navigation so a tab exists — some Playwright MCP
          // servers reject browser_resize on a tabless browser. Best-effort:
          // a resize failure must never fail the case.
          try {
            await connection.tools.callTool(
              "browser_resize",
              { width: settings?.viewportWidth ?? 1920, height: settings?.viewportHeight ?? 1080 },
              context.signal,
            );
          } catch {
            // Viewport sizing is best-effort and must never fail the case.
          }
        }
        if (!baseNavigationFailed) for (const step of steps) {
          if (step.status === "passed") continue;
          if (context.signal.aborted || await isRunCancellationRequested(payload.runId)) {
            outcome = "cancelled"; errorMessage = "Execution was cancelled.";
            await finishStep(step.id, outcome, errorMessage, secretValues); break;
          }
          try {
            const result = await executeTestStepWithAgent({
              action: step.action, expectedResult: step.expectedResult, llm, tools: connection.tools,
              signal: context.signal, toolPolicy, runContext,
              onEvent: async (event) => {
                if (event.kind === "tool_call") {
                  await recordStepToolCall(step.id, event.toolName, event.arguments, event.result, secretValues);
                  await importInlineMcpArtifacts({ workspaceId: workspace.id, runId: payload.runId,
                    caseId: testCase.id, stepId: step.id, toolName: event.toolName, result: event.result,
                    persistInlineScreenshots: screenshotPolicy !== "none", secrets: secretValues });
                  if (mcpConfig.transport === "http" && mcpConfig.artifactBaseUrl) {
                    for (const sourceUrl of artifactUrls(event.result)) {
                      await importHttpArtifact({ workspaceId: workspace.id, runId: payload.runId,
                        caseId: testCase.id, stepId: step.id, sourceUrl,
                        artifactBaseUrl: mcpConfig.artifactBaseUrl, bearerToken: mcpConfig.bearerToken,
                        kind: sourceUrl.toLowerCase().includes("trace") ? "trace" : "log" });
                    }
                  }
                }
              },
            });
            await finishStep(step.id, result.outcome, result.outcome === "passed" ? null : result.summary, secretValues);
            if (shouldCaptureScreenshot(screenshotPolicy, { hasExpectedResult: Boolean(step.expectedResult), outcome: result.outcome })) {
              await captureStepScreenshot(step.id);
            }
            if (result.outcome !== "passed") { outcome = result.outcome; errorMessage = result.summary; break; }
          } catch (error) {
            outcome = context.signal.aborted ? "cancelled" : "error";
            errorMessage = error instanceof Error ? error.message : "Playwright step failed.";
            await finishStep(step.id, outcome, errorMessage, secretValues);
            if (shouldCaptureScreenshot(screenshotPolicy, { hasExpectedResult: Boolean(step.expectedResult), outcome })) {
              await captureStepScreenshot(step.id);
            }
            break;
          }
        }
      } finally {
        await connection.close().catch(() => undefined);
      }
      await finishCase(testCase.id, outcome, errorMessage, secretValues);
      await incrementCompletedCases(payload.runId);
      outcomes.push(outcome);
    }
    const outcome = combineOutcomes(outcomes);
    await finishRun(payload.runId, outcome, outcome === "passed" ? null : "One or more test cases did not pass.", secretValues);
    return { runId: payload.runId, outcome, completedCases: outcomes.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Playwright execution failed.";
    await finishRun(payload.runId, context.signal.aborted ? "cancelled" : "error", message);
    throw error;
  }
};
