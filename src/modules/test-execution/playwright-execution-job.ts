import "server-only";

import { resolveUserLlmConfig } from "@/modules/credentials/credential.service";
import { createEgressAuthorizer, authorizeEgressTarget, type EgressBoundary, type EgressTarget } from "@/modules/integrations/api-automation/egress-boundary";
import { GuardedApiExecutor } from "@/modules/integrations/api-automation/guarded-api-executor";
import { createDatabaseExecutor } from "@/modules/integrations/database-automation/database-executor.factory";
import type { DatabaseExecutor } from "@/modules/integrations/database-automation/database-executor.port";
import type { JobHandler } from "@/modules/jobs/job-handlers";
import { DEFAULT_RETRY_ATTEMPTS, getMaxOutputTokenCapDefaultFromEnv } from "@/modules/llm/llm-defaults";
import { createLLMProvider } from "@/modules/llm/llm-provider.factory";
import type { ProjectScope } from "@/modules/projects/project-isolation.guard";
import { getWorkspaceById } from "@/modules/workspace/workspace.service";
import { getWorkspaceSettings } from "@/modules/workspace/workspace-settings.service";
import { artifactUrls, importHttpArtifact, importInlineMcpArtifacts } from "./execution-artifact.service";
import { asApiConnection, asDatabaseConnection, toApiExecutorConfig, toDatabaseExecutorConfig } from "./execution-connections.adapters";
import { resolveRunConnections } from "./execution-connections.service";
import type { ResolvedConnection } from "./execution-connections.shared";
import { startOperation, finishOperation } from "./execution-operation.service";
import { sanitizeExecutionError, sanitizeExecutionPayload } from "./execution-redaction";
import {
  casesForRun, executionConfigSnapshot, executionRunSettings, finishCase, finishRun, finishStep, incrementCompletedCases,
  isRunCancellationRequested, markCaseStarted, markRunStarted, markStepStarted, recordStepToolCall,
  skipRemainingQueuedSteps, stepsForCase, type StoredStep,
} from "./execution-store.service";
import { decryptedRunTestData } from "./execution-test-data.service";
import { ApiRequestArguments, AssertArguments, CaptureArguments, DatabaseQueryArguments, DatabaseSchemaArguments, executeMixedTestStep, type MixedToolResult } from "./mixed-execution-agent";
import { CaseCaptures, assertResult, substituteTestData } from "./mixed-execution-captures";
import { discoverOpenApiOperations, type OpenApiOperation } from "./openapi-discovery";
import { assertAllowedBrowserState, assertAllowedPlaywrightTool, createPlaywrightToolPolicy, type ExecutionOutcome, validatePlaywrightToolArguments } from "./playwright-agent";
import { connectPlaywrightMcp } from "./playwright-mcp-client";
import { resolvePlaywrightMcpConfig } from "./playwright-mcp-config.service";
import { DEFAULT_SCREENSHOT_POLICY, shouldCaptureScreenshot } from "./screenshot-policy";

type Payload = { runId: string; userId: string; scope: ProjectScope };
type BrowserConnection = Awaited<ReturnType<typeof connectPlaywrightMcp>>;

class LeaseLostError extends Error {
  constructor() { super("Execution worker no longer owns this run."); }
}

function parsePayload(payload: Record<string, unknown>): Payload {
  const runId = typeof payload.runId === "string" ? payload.runId : "";
  const userId = typeof payload.userId === "string" ? payload.userId : "";
  const scope = payload.scope as ProjectScope | undefined;
  if (!runId || !userId || !scope?.projectId || !scope.azureProjectId) throw new Error("Invalid execution job payload.");
  return { runId, userId, scope };
}

function combineOutcomes(outcomes: ExecutionOutcome[]): ExecutionOutcome {
  for (const value of ["error", "timeout", "failed", "blocked", "cancelled"] as const) if (outcomes.includes(value)) return value;
  return "passed";
}

async function requireOwnership(update: Promise<boolean>): Promise<void> {
  if (!await update) throw new LeaseLostError();
}

function targetForUrl(value: string, kind: "api" | "oauth" | "openapi"): EgressTarget {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Connection target must use HTTP or HTTPS.");
  return { kind, protocol: url.protocol === "https:" ? "https" : "http", host: url.hostname, port: Number(url.port) || (url.protocol === "https:" ? 443 : 80) };
}

/** Scope is fixed from encrypted run snapshot. DNS is rechecked before each socket. */
function runEgressBoundary(connections: readonly ResolvedConnection[]): EgressBoundary {
  const targets: EgressTarget[] = [];
  for (const connection of connections) {
    if (connection.kind === "api") {
      targets.push(targetForUrl(connection.baseUrl, "api"));
      if (connection.auth.type === "oauth2ClientCredentials") targets.push(targetForUrl(connection.auth.tokenUrl, "oauth"));
      if (connection.openApiUrl) targets.push(targetForUrl(connection.openApiUrl, "openapi"));
    } else {
      const config = toDatabaseExecutorConfig(asDatabaseConnection(connection), new AbortController().signal, async () => ({ resolvedAddresses: [] }));
      targets.push({ kind: "db", protocol: "tcp", host: config.host, port: config.port });
    }
  }
  return { targets, privateCidrs: (process.env.TEST_EXECUTION_PRIVATE_CIDRS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean) };
}

function shapeOf(value: unknown, depth = 0): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) return { type: "array", length: value.length, item: depth < 2 && value.length ? shapeOf(value[0], depth + 1) : undefined };
  if (typeof value === "object") return { type: "object", fields: Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, depth < 2 ? shapeOf(item, depth + 1) : typeof item])) };
  return typeof value;
}

function modelSafeText(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[REDACTED]");
  return sanitizeExecutionError(safe, secrets);
}

function modelSafeBrowserResult(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > 7) return "[TRUNCATED]";
  if (typeof value === "string") return modelSafeText(value, secrets);
  if (Array.isArray(value)) return value.slice(0, 30).map((entry) => modelSafeBrowserResult(entry, secrets, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).slice(0, 40).map(([key, entry]) => [key,
      key === "data" && record.type === "image" ? "[IMAGE]"
        : /^(authorization|cookie|password|secret|token|api.?key|value)$/i.test(key) ? "[REDACTED]"
          : modelSafeBrowserResult(entry, secrets, depth + 1)]));
  }
  return value;
}

/** Never serialize query rows or captured values into model observations. */
function safeObservation(name: string, result: unknown): unknown {
  if (name === "api_request") {
    const api = result as { statusCode: number; statusText: string; body: unknown; contentType: string | null; truncated: boolean; durationMs: number };
    return { statusCode: api.statusCode, statusText: api.statusText, bodyShape: shapeOf(api.body), contentType: api.contentType, truncated: api.truncated, durationMs: api.durationMs };
  }
  if (name === "database_query") {
    const db = result as { status: string; command: string; rowCount: number; columns: string[]; truncated: boolean; durationMs: number; errorMessage?: string };
    return { status: db.status, command: db.command, rowCount: db.rowCount, columns: db.columns, truncated: db.truncated, durationMs: db.durationMs, errorMessage: db.errorMessage };
  }
  return result;
}

export const runPlaywrightExecutionJob: JobHandler = async (job, context) => {
  const payload = parsePayload(job.payload);
  const workerId = context.workerId;
  let secrets: string[] = [];
  try {
    await requireOwnership(markRunStarted(payload.runId, workerId));
    const workspace = await getWorkspaceById(job.workspaceId ?? "");
    if (!workspace) throw new Error("Execution workspace no longer exists.");
    const settings = await executionRunSettings(payload.runId);
    if (!settings) throw new Error("Execution run settings no longer exist.");
    const [llmConfig, workspaceSettings, runTestData, connections, mcpConfig] = await Promise.all([
      resolveUserLlmConfig(workspace.id, payload.userId),
      getWorkspaceSettings(workspace.id),
      decryptedRunTestData(payload.runId),
      resolveRunConnections(payload.runId),
      settings.browserEnabled ? resolvePlaywrightMcpConfig(workspace.id) : Promise.resolve(null),
    ]);
    if (!llmConfig) throw new Error("The requesting user's LLM credentials are no longer configured.");
    if (settings.browserEnabled && (!mcpConfig || mcpConfig.status !== "configured")) throw new Error("Playwright MCP is no longer configured and enabled.");
    const snapshot = await executionConfigSnapshot(payload.runId);
    if (settings.browserEnabled && (!snapshot || snapshot.transport !== mcpConfig?.transport || (snapshot.endpoint ?? null) !== (mcpConfig?.endpoint ?? null) || (snapshot.artifactBaseUrl ?? null) !== (mcpConfig?.artifactBaseUrl ?? null))) {
      throw new Error("Playwright MCP configuration changed after this run was queued. Start a new execution.");
    }
    const toolPolicy = settings.browserEnabled && mcpConfig?.status === "configured" ? createPlaywrightToolPolicy(mcpConfig.transport!) : null;
    secrets = [...runTestData.filter((entry) => entry.isSecret).map((entry) => entry.value), ...connections.flatMap((entry) => Object.values(entry.credentials))].filter(Boolean);
    const llm = createLLMProvider({ ...llmConfig,
      maxInputTokens: workspaceSettings?.modelInputTokenLimitOverride ?? undefined,
      maxOutputTokenCap: workspaceSettings?.maxOutputTokenCap ?? getMaxOutputTokenCapDefaultFromEnv(),
      retryAttempts: workspaceSettings?.llmRetryAttempts ?? DEFAULT_RETRY_ATTEMPTS });
    const boundary = runEgressBoundary(connections);
    const authorizeHttp = createEgressAuthorizer(boundary);
    const byAlias = new Map(connections.map((entry) => [entry.alias, entry]));
    const cases = await casesForRun(payload.runId);
    const firstStep = cases.length ? (await stepsForCase(cases[0].id))[0] : undefined;
    const openApi = new Map<string, OpenApiOperation[]>();
    for (const connection of connections) {
      if (connection.kind !== "api" || !connection.openApiUrl || !firstStep) continue;
      const operationId = await startOperation({ runId: payload.runId, caseId: cases[0].id, stepId: firstStep.id, workerId, connectionAlias: connection.alias, operation: "OpenAPI discovery" });
      if (!operationId) throw new LeaseLostError();
      try {
        const operations = await discoverOpenApiOperations(connection.openApiUrl, authorizeHttp, context.signal);
        openApi.set(connection.alias, operations.slice(0, 30));
        await requireOwnership(finishOperation({ operationId, workerId, status: "completed", evidence: { operationCount: operations.length }, secrets }));
      } catch (error) {
        if (error instanceof LeaseLostError) throw error;
        await requireOwnership(finishOperation({ operationId, workerId, status: "failed", errorMessage: "Optional OpenAPI discovery failed.", secrets }));
      }
    }
    const outcomes: ExecutionOutcome[] = [];
    let cancelledBeforeCase = false;
    for (const [caseIndex, testCase] of cases.entries()) {
      if (!["queued", "running"].includes(testCase.status)) { outcomes.push(testCase.status as ExecutionOutcome); continue; }
      if (context.signal.aborted || await isRunCancellationRequested(payload.runId)) { cancelledBeforeCase = true; break; }
      await requireOwnership(markCaseStarted(testCase.id, workerId));
      await context.updateProgress({ phase: "executing", caseIndex, totalCases: cases.length, testCaseId: testCase.azureTestCaseId });
      const captures = new CaseCaptures();
      const allSecrets = () => [...secrets, ...captures.secretValues()];
      const steps = await stepsForCase(testCase.id);
      // Phase labels do not reorder authored UI/API/DB/UI transitions.
      const orderedSteps = steps;
      let outcome: ExecutionOutcome = steps.length ? "passed" : "blocked";
      let errorMessage: string | null = steps.length ? null : "Test case has no executable steps.";
      let browser: BrowserConnection | null = null;
      try {
        if (settings.browserEnabled && mcpConfig?.status === "configured") {
          const first = orderedSteps[0];
          const operationId = first ? await startOperation({ runId: payload.runId, caseId: testCase.id, stepId: first.id, workerId, operation: "Browser connection" }) : null;
          if (!operationId) throw new LeaseLostError();
          try {
            browser = await connectPlaywrightMcp(mcpConfig, { headless: settings.headless });
            await requireOwnership(finishOperation({ operationId, workerId, status: "completed", evidence: { connected: true }, secrets }));
          } catch (error) {
            await requireOwnership(finishOperation({ operationId, workerId, status: "failed", errorMessage: "Browser connection failed.", secrets }));
            throw error;
          }
        }
      } catch (error) { if (error instanceof LeaseLostError) throw error; outcome = "error"; errorMessage = "Playwright MCP connection failed."; }
      const screenshotPolicy = settings.screenshotPolicy ?? DEFAULT_SCREENSHOT_POLICY;
      let browserInitialized = false;
      const executePhase = async (step: StoredStep, signal: AbortSignal): Promise<{ outcome: ExecutionOutcome; summary: string; usedBrowser: boolean }> => {
        const apiExecutors = new Map<string, GuardedApiExecutor>();
        const databaseExecutors = new Map<string, DatabaseExecutor>();
        const discovered = new Set<string>();
        let latestResult: unknown = null;
        let mutationSent = false;
        let usedBrowser = false;
        const journal = async <T>(alias: string | null, operation: string, dispatch: () => Promise<T>, evidence: (value: T) => unknown): Promise<T> => {
          const operationId = await startOperation({ runId: payload.runId, caseId: testCase.id, stepId: step.id, workerId, connectionAlias: alias, operation });
          if (!operationId) throw new LeaseLostError();
          let value: T;
          try { value = await dispatch(); }
          catch (error) {
            const uncertain = Boolean(error && typeof error === "object" && "uncertainSideEffect" in error && error.uncertainSideEffect);
            await requireOwnership(finishOperation({ operationId, workerId, status: uncertain ? "uncertain" : "failed", errorMessage: modelSafeText(error instanceof Error ? error.message : "Operation failed.", allSecrets()), secrets: allSecrets() }));
            throw error;
          }
          const queryFailed = Boolean(value && typeof value === "object" && "status" in value && value.status === "query_error");
          await requireOwnership(finishOperation({ operationId, workerId, status: queryFailed ? "failed" : "completed", evidence: modelSafeBrowserResult(evidence(value), allSecrets()),
            errorMessage: queryFailed ? "Database query failed." : null, secrets: allSecrets() }));
          return value;
        };
        const database = (alias: string): DatabaseExecutor => {
          const connection = byAlias.get(alias);
          if (!connection || connection.kind !== "database") throw new Error(`Database alias "${alias}" is unavailable.`);
          let executor = databaseExecutors.get(alias);
          if (!executor) {
            executor = createDatabaseExecutor(toDatabaseExecutorConfig(asDatabaseConnection(connection), signal,
              (target) => authorizeEgressTarget(boundary, { kind: "db", protocol: "tcp", host: target.host, port: target.port })));
            databaseExecutors.set(alias, executor);
          }
          return executor;
        };
        const discover = async (alias: string, executor: DatabaseExecutor) => {
          const result = await journal(alias, "Database schema discovery", () => executor.discoverObjects(),
            (value) => ({ objectCount: value.objects.length, truncated: value.truncated }));
          executor.setDatabaseAccess({ schemas: [...new Set(result.objects.map((object) => object.schema))], tables: new Set(result.objects.map((object) => `${object.schema}.${object.table}`)) });
          discovered.add(alias);
          return result;
        };
        try {
          const result = await executeMixedTestStep({
            action: modelSafeText(step.action, allSecrets()),
            expectedResult: step.expectedResult ? modelSafeText(step.expectedResult, allSecrets()) : null,
            notes: settings.executionNotes ? modelSafeText(settings.executionNotes, allSecrets()) : null,
            aliases: connections.map((entry) => ({ alias: entry.alias, kind: entry.kind, allowWrites: entry.allowWrites })),
            captureNames: () => captures.names(), testDataTitles: runTestData.map((entry) => entry.title), openApi: Object.fromEntries(openApi), llm, signal,
            browserTools: browser?.tools.toolDefinitions.filter((tool) => { try { assertAllowedPlaywrightTool(tool.name); return true; } catch { return false; } }),
            executeTool: async (name, args): Promise<MixedToolResult> => {
              if (name === "capture_value") {
                const parsed = CaptureArguments.parse(args);
                await journal(null, "Capture result value", async () => captures.capture(parsed.name, latestResult, parsed.path), () => ({ name: parsed.name, captured: true }));
                return { observation: { name: parsed.name, captured: true }, succeeded: true };
              }
              if (name === "assert_value") {
                const parsed = AssertArguments.parse(args);
                const expected = captures.substitute(substituteTestData(parsed.expected, runTestData));
                const passed = await journal(null, "Assert result value", async () => assertResult(latestResult, parsed.path, parsed.operator, expected), (value) => ({ path: parsed.path, operator: parsed.operator, passed: value }));
                return { observation: { passed }, succeeded: passed, assertionPassed: passed };
              }
              let observation: unknown;
              let succeeded = true;
              let alias: string | null = null;
              if (name === "api_request") {
                const parsed = ApiRequestArguments.parse(args);
                const connection = byAlias.get(parsed.alias);
                if (!connection || connection.kind !== "api") throw new Error(`API alias "${parsed.alias}" is unavailable.`);
                alias = parsed.alias;
                const mutation = parsed.method !== "GET" && parsed.method !== "HEAD";
                if (mutationSent && mutation) throw new Error("Only one write is allowed per test step; verify its result before another write.");
                let executor = apiExecutors.get(alias);
                if (!executor) { executor = new GuardedApiExecutor(toApiExecutorConfig(asApiConnection(connection), signal, authorizeHttp)); apiExecutors.set(alias, executor); }
                const request = captures.substitute(substituteTestData(parsed, runTestData));
                if (mutation) mutationSent = true;
                const apiResult = await journal(alias, `API ${parsed.method}`, () => executor!.execute(request), (value) => safeObservation(name, value));
                const localRawBody = (apiResult as typeof apiResult & { rawBody?: unknown }).rawBody;
                latestResult = { ...apiResult, body: localRawBody ?? apiResult.body };
                observation = safeObservation(name, apiResult);
                succeeded = apiResult.statusCode < 400;
              } else if (name === "database_schema") {
                const parsed = DatabaseSchemaArguments.parse(args);
                alias = parsed.alias;
                latestResult = await discover(alias, database(alias));
                observation = latestResult;
              } else if (name === "database_query") {
                const parsed = DatabaseQueryArguments.parse(args);
                alias = parsed.alias;
                if (/\{\{capture:/.test(parsed.sql)) throw new Error("Captured values belong in named SQL parameters, never SQL text.");
                if (mutationSent && parsed.kind === "mutation") throw new Error("Only one write is allowed per test step; verify its result before another write.");
                const executor = database(alias);
                if (!discovered.has(alias)) await discover(alias, executor);
                if (parsed.kind === "mutation") mutationSent = true;
                const request = { ...parsed, parameters: captures.substitute(substituteTestData(parsed.parameters ?? {}, runTestData)) };
                latestResult = await journal(alias, `Database ${parsed.kind}`, () => executor.execute(request), (value) => safeObservation(name, value));
                observation = safeObservation(name, latestResult);
                succeeded = (latestResult as { status: string }).status === "ok";
              } else if (name.startsWith("browser_") && browser && toolPolicy) {
                assertAllowedPlaywrightTool(name);
                usedBrowser = true;
                if (!browserInitialized && settings.baseUrl && name !== "browser_navigate") {
                  const baseArgs = await validatePlaywrightToolArguments("browser_navigate", { url: settings.baseUrl }, toolPolicy);
                  const opened = await journal(null, "Browser base navigation", () => browser!.tools.callTool("browser_navigate", baseArgs, signal),
                    (value) => ({ navigated: value.isError !== true }));
                  if (opened.isError === true) throw new Error("Browser could not open the Base URL.");
                  browserInitialized = true;
                  try {
                    await journal(null, "Browser viewport resize", () => browser!.tools.callTool("browser_resize", { width: settings.viewportWidth, height: settings.viewportHeight }, signal),
                      (value) => ({ resized: value.isError !== true }));
                  } catch (error) { if (error instanceof LeaseLostError) throw error; /* viewport sizing is best-effort */ }
                }
                const safeArgs = await validatePlaywrightToolArguments(name, captures.substitute(substituteTestData(args, runTestData)), toolPolicy);
                assertAllowedBrowserState(await browser.tools.listOpenTabs(signal), toolPolicy);
                const toolResult = await journal(null, `Browser ${name}`, () => browser!.tools.callTool(name, safeArgs, signal),
                  (value) => ({ isError: value.isError === true, content: name === "browser_file_upload" ? "[fixture]" : sanitizeExecutionPayload(value, allSecrets()) }));
                assertAllowedBrowserState(await browser.tools.listOpenTabs(signal), toolPolicy);
                if (name === "browser_navigate" && toolResult.isError !== true) browserInitialized = true;
                latestResult = toolResult;
                observation = name === "browser_file_upload" ? { status: "fixture upload completed", isError: toolResult.isError === true } : modelSafeBrowserResult(toolResult, allSecrets());
                succeeded = toolResult.isError !== true;
                await importInlineMcpArtifacts({ workspaceId: workspace.id, runId: payload.runId, caseId: testCase.id, stepId: step.id, toolName: name, result: toolResult,
                  persistInlineScreenshots: screenshotPolicy !== "none", secrets: allSecrets() });
                if (mcpConfig?.status === "configured" && mcpConfig.transport === "http" && mcpConfig.artifactBaseUrl) {
                  for (const sourceUrl of artifactUrls(toolResult)) await importHttpArtifact({ workspaceId: workspace.id, runId: payload.runId, caseId: testCase.id, stepId: step.id,
                    sourceUrl, artifactBaseUrl: mcpConfig.artifactBaseUrl, bearerToken: mcpConfig.bearerToken,
                    kind: sourceUrl.toLowerCase().includes("trace") ? "trace" : "log" });
                }
              } else throw new Error(`Mixed execution tool "${name}" is unavailable.`);
              const auditArgs = name === "api_request"
                ? { alias, method: (args as { method?: unknown }).method, request: "[body and path omitted]" }
                : name === "database_query"
                  ? { alias, kind: (args as { kind?: unknown }).kind, query: "[SQL and parameters omitted]" }
                  : name === "browser_file_upload" ? { paths: "[fixture]" } : args;
              await requireOwnership(recordStepToolCall(step.id, name, modelSafeBrowserResult(auditArgs, allSecrets()) as Record<string, unknown>,
                modelSafeBrowserResult(observation, allSecrets()), allSecrets(), workerId));
              return { observation, succeeded, external: true };
            },
          });
          return { ...result, usedBrowser };
        } finally {
          await Promise.allSettled([...apiExecutors.values()].map((executor) => executor.dispose()));
          await Promise.allSettled([...databaseExecutors.values()].map((executor) => executor.dispose()));
        }
      };
      try {
        const cleanupController = new AbortController();
        let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
        try { for (const step of orderedSteps) {
          const cleanup = step.phase === "cleanup";
          if (cleanup && cleanupController.signal.aborted) { if (outcome === "passed") { outcome = "timeout"; errorMessage = "Cleanup exceeded 60 seconds."; } break; }
          if (!cleanup && outcome !== "passed") continue;
          if (!cleanup && (context.signal.aborted || await isRunCancellationRequested(payload.runId))) {
            outcome = "cancelled"; errorMessage = "Execution was cancelled."; continue;
          }
          if (step.status === "passed") continue;
          if (step.status === "running") {
            outcome = "error"; errorMessage = "Previous execution stopped during this step; uncertain operations were not replayed.";
            await requireOwnership(finishStep(step.id, "error", errorMessage, allSecrets(), workerId));
            continue;
          }
          await requireOwnership(markStepStarted(step.id, workerId));
          if (cleanup && !cleanupTimer) cleanupTimer = setTimeout(() => cleanupController.abort(new Error("Cleanup exceeded 60 seconds.")), 60_000);
          const signal = cleanup ? cleanupController.signal : context.signal;
          try {
            if (!browser && settings.browserEnabled && !cleanup) throw new Error("Browser session is unavailable.");
            const result = await executePhase(step, signal);
            const stepOutcome: ExecutionOutcome = cleanup && cleanupController.signal.aborted ? "timeout" : result.outcome;
            const summary = stepOutcome === "timeout" && cleanup ? "Cleanup exceeded 60 seconds." : result.summary;
            await requireOwnership(finishStep(step.id, stepOutcome, stepOutcome === "passed" ? null : modelSafeText(summary, allSecrets()), allSecrets(), workerId));
            if (!signal.aborted && browser && browserInitialized && result.usedBrowser && shouldCaptureScreenshot(screenshotPolicy, { hasExpectedResult: Boolean(step.expectedResult), outcome: stepOutcome })) {
              try {
                const operationId = await startOperation({ runId: payload.runId, caseId: testCase.id, stepId: step.id, workerId, operation: "Browser screenshot" });
                if (!operationId) throw new LeaseLostError();
                const screenshot = await browser.tools.callTool("browser_take_screenshot", {}, signal);
                await importInlineMcpArtifacts({ workspaceId: workspace.id, runId: payload.runId, caseId: testCase.id, stepId: step.id, toolName: "browser_take_screenshot", result: screenshot, secrets: allSecrets() });
                await requireOwnership(finishOperation({ operationId, workerId, status: screenshot.isError ? "failed" : "completed", evidence: { screenshot: screenshot.isError !== true }, secrets: allSecrets() }));
              } catch (error) { if (error instanceof LeaseLostError) throw error; /* evidence is best-effort */ }
            }
            if (stepOutcome !== "passed") {
              if (!cleanup || outcome === "passed") { outcome = stepOutcome; errorMessage = modelSafeText(summary, allSecrets()); }
            }
            if (cleanup && cleanupController.signal.aborted) break;
          } catch (error) {
            if (error instanceof LeaseLostError) throw error;
            const message = error instanceof Error ? error.message : "Execution step failed.";
            const stepOutcome: ExecutionOutcome = signal.aborted ? cleanup ? "timeout" : "cancelled" : "error";
            await requireOwnership(finishStep(step.id, stepOutcome, modelSafeText(message, allSecrets()), allSecrets(), workerId));
            if (!cleanup || outcome === "passed") { outcome = stepOutcome; errorMessage = modelSafeText(message, allSecrets()); }
            if (cleanup && cleanupController.signal.aborted) break;
          }
        } } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      } finally { await browser?.close().catch(() => undefined); }
      if (outcome !== "passed" && outcome !== "cancelled") await requireOwnership(skipRemainingQueuedSteps(testCase.id, workerId));
      await requireOwnership(finishCase(testCase.id, outcome, errorMessage ? modelSafeText(errorMessage, allSecrets()) : null, allSecrets(), workerId));
      await requireOwnership(incrementCompletedCases(payload.runId, workerId));
      outcomes.push(outcome);
    }
    const outcome = cancelledBeforeCase && outcomes.every((value) => value === "passed") ? "cancelled" : combineOutcomes(outcomes);
    await requireOwnership(finishRun(payload.runId, outcome, outcome === "passed" ? null : "One or more test cases did not pass.", secrets, workerId));
    return { runId: payload.runId, outcome, completedCases: outcomes.length };
  } catch (error) {
    if (!(error instanceof LeaseLostError)) {
      await finishRun(payload.runId, context.signal.aborted ? "cancelled" : "error", modelSafeText(error instanceof Error ? error.message : "Execution failed.", secrets), secrets, workerId).catch(() => false);
    }
    throw error;
  }
};
