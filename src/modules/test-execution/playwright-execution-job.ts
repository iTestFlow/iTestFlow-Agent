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
  casesForRun, executionConfigSnapshot, finishCase, finishRun, finishStep, incrementCompletedCases, isRunCancellationRequested,
  markCaseStarted, markRunStarted, recordStepToolCall, stepsForCase,
} from "./execution-store.service";
import { createPlaywrightToolPolicy, executeTestStepWithAgent, type ExecutionOutcome } from "./playwright-agent";
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
  const currentNonSecretConfig = { transport: mcpConfig.transport, endpoint: mcpConfig.endpoint, artifactBaseUrl: mcpConfig.artifactBaseUrl };
  if (!snapshot || JSON.stringify(snapshot) !== JSON.stringify(currentNonSecretConfig)) {
    throw new Error("Playwright MCP configuration changed after this run was queued. Start a new execution.");
  }
  const azure = createIntegrationProvider({
    providerId: resolveWorkspaceProviderId(workspace),
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
        connection = await connectPlaywrightMcp(mcpConfig);
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : "Playwright MCP connection failed.";
        await finishCase(testCase.id, "error", errorMessage);
        await incrementCompletedCases(payload.runId);
        outcomes.push("error");
        continue;
      }
      try {
        const steps = await stepsForCase(testCase.id);
        if (!steps.length) { outcome = "blocked"; errorMessage = "Azure Test Case has no executable steps."; }
        for (const step of steps) {
          if (step.status === "passed") continue;
          if (context.signal.aborted || await isRunCancellationRequested(payload.runId)) {
            outcome = "cancelled"; errorMessage = "Execution was cancelled.";
            await finishStep(step.id, outcome, errorMessage); break;
          }
          try {
            const result = await executeTestStepWithAgent({
              action: step.action, expectedResult: step.expectedResult, llm, tools: connection.tools,
              signal: context.signal, toolPolicy,
              onEvent: async (event) => {
                if (event.kind === "tool_call") {
                  await recordStepToolCall(step.id, event.toolName, event.arguments, event.result);
                  await importInlineMcpArtifacts({ workspaceId: workspace.id, runId: payload.runId,
                    caseId: testCase.id, stepId: step.id, toolName: event.toolName, result: event.result });
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
            await finishStep(step.id, result.outcome, result.outcome === "passed" ? null : result.summary);
            if (result.outcome !== "passed") { outcome = result.outcome; errorMessage = result.summary; break; }
          } catch (error) {
            outcome = context.signal.aborted ? "cancelled" : "error";
            errorMessage = error instanceof Error ? error.message : "Playwright step failed.";
            await finishStep(step.id, outcome, errorMessage); break;
          }
        }
      } finally {
        await connection.close().catch(() => undefined);
      }
      await finishCase(testCase.id, outcome, errorMessage);
      await incrementCompletedCases(payload.runId);
      outcomes.push(outcome);
    }
    const outcome = combineOutcomes(outcomes);
    await finishRun(payload.runId, outcome, outcome === "passed" ? null : "One or more test cases did not pass.");
    return { runId: payload.runId, outcome, completedCases: outcomes.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Playwright execution failed.";
    await finishRun(payload.runId, context.signal.aborted ? "cancelled" : "error", message);
    throw error;
  }
};
