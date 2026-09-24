import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  markRunStarted: vi.fn(async () => true), markCaseStarted: vi.fn(async () => true), markStepStarted: vi.fn(async () => true),
  finishRun: vi.fn(async () => true), finishCase: vi.fn(async () => true), finishStep: vi.fn(async () => true),
  incrementCompletedCases: vi.fn(async () => true), skipRemainingQueuedSteps: vi.fn(async () => true),
  recordStepToolCall: vi.fn(async (..._args: unknown[]) => true), isRunCancellationRequested: vi.fn(async () => false),
  casesForRun: vi.fn(), stepsForCase: vi.fn(), executionRunSettings: vi.fn(), executionConfigSnapshot: vi.fn(),
}));
const deps = vi.hoisted(() => ({
  connections: vi.fn(), testData: vi.fn(), mcpConfig: vi.fn(), connectMcp: vi.fn(),
  mixedAgent: vi.fn(), startOperation: vi.fn(), finishOperation: vi.fn(async (..._args: Array<{ evidence?: unknown }>) => true),
  apiExecute: vi.fn(), databaseExecute: vi.fn(), databaseDiscover: vi.fn(), setDatabaseAccess: vi.fn(),
  importArtifact: vi.fn(), openApi: vi.fn(),
}));

vi.mock("@/modules/credentials/credential.service", () => ({ resolveUserLlmConfig: vi.fn(async () => ({ provider: "openai", model: "test" })) }));
vi.mock("@/modules/llm/llm-defaults", () => ({ DEFAULT_RETRY_ATTEMPTS: 1, getMaxOutputTokenCapDefaultFromEnv: vi.fn(() => 1000) }));
vi.mock("@/modules/llm/llm-provider.factory", () => ({ createLLMProvider: vi.fn(() => ({})) }));
vi.mock("@/modules/workspace/workspace.service", () => ({ getWorkspaceById: vi.fn(async () => ({ id: "w" })) }));
vi.mock("@/modules/workspace/workspace-settings.service", () => ({ getWorkspaceSettings: vi.fn(async () => null) }));
vi.mock("./execution-store.service", () => store);
vi.mock("./execution-test-data.service", () => ({ decryptedRunTestData: deps.testData }));
vi.mock("./execution-connections.service", () => ({ resolveRunConnections: deps.connections }));
vi.mock("./execution-connections.adapters", () => ({
  asApiConnection: (value: unknown) => value, asDatabaseConnection: (value: unknown) => value,
  toApiExecutorConfig: (value: unknown) => value,
  toDatabaseExecutorConfig: (value: { engine: string; host: string; port: number; database: string; username: string }, signal: AbortSignal, authorizeTarget: unknown) => ({ driver: value.engine, host: value.host, port: value.port, databaseName: value.database, username: value.username, credentials: { password: "db-secret" }, signal, authorizeTarget }),
}));
vi.mock("@/modules/integrations/api-automation/egress-boundary", () => ({
  createEgressAuthorizer: vi.fn(() => async () => ({ resolvedAddresses: ["203.0.113.1"] })),
  authorizeEgressTarget: vi.fn(async () => ({ resolvedAddresses: ["203.0.113.1"] })),
}));
vi.mock("@/modules/integrations/api-automation/guarded-api-executor", () => ({
  GuardedApiExecutor: class { execute = deps.apiExecute; dispose = vi.fn(async () => undefined); },
}));
vi.mock("@/modules/integrations/database-automation/database-executor.factory", () => ({
  createDatabaseExecutor: vi.fn(() => ({ driver: "postgres", execute: deps.databaseExecute, discoverObjects: deps.databaseDiscover, setDatabaseAccess: deps.setDatabaseAccess, dispose: vi.fn(async () => undefined) })),
}));
vi.mock("./execution-operation.service", () => ({ startOperation: deps.startOperation, finishOperation: deps.finishOperation }));
vi.mock("./mixed-execution-agent", () => ({
  ApiRequestArguments: { parse: (value: unknown) => value }, DatabaseSchemaArguments: { parse: (value: unknown) => value },
  DatabaseQueryArguments: { parse: (value: unknown) => value }, CaptureArguments: { parse: (value: unknown) => value },
  AssertArguments: { parse: (value: unknown) => value }, executeMixedTestStep: deps.mixedAgent,
}));
vi.mock("./openapi-discovery", () => ({ discoverOpenApiOperations: deps.openApi }));
vi.mock("./playwright-agent", () => ({
  createPlaywrightToolPolicy: vi.fn(() => ({ transport: "stdio", allowAllOrigins: false, allowedNavigationOrigins: new Set(["https://app.example.com"]), uploadRoots: [] })),
  assertAllowedPlaywrightTool: (name: string) => { if (!name.startsWith("browser_")) throw new Error("not allowed"); },
  assertAllowedBrowserState: vi.fn(), validatePlaywrightToolArguments: vi.fn(async (_name: string, args: unknown) => args),
}));
vi.mock("./playwright-mcp-client", () => ({ connectPlaywrightMcp: deps.connectMcp }));
vi.mock("./playwright-mcp-config.service", () => ({ resolvePlaywrightMcpConfig: deps.mcpConfig }));
vi.mock("./execution-artifact.service", () => ({ artifactUrls: vi.fn(() => []), importHttpArtifact: vi.fn(), importInlineMcpArtifacts: deps.importArtifact }));

import { runPlaywrightExecutionJob } from "./playwright-execution-job";

const job = { workspaceId: "w", payload: { runId: "r", userId: "u", scope: { projectId: "p", azureProjectId: "ap" } } } as never;
const context = () => ({ workerId: "worker", signal: new AbortController().signal, updateProgress: vi.fn(async () => undefined) }) as never;

function apiConnection() {
  return { kind: "api" as const, alias: "service", baseUrl: "https://api.example.com", auth: { type: "bearer" as const }, allowWrites: false,
    credentials: { bearerToken: "api-secret" } };
}
function dbConnection() {
  return { kind: "database" as const, alias: "records", engine: "postgres" as const, host: "db.example.com", port: 5432,
    database: "test", username: "qa", allowWrites: false, credentials: { password: "db-secret" } };
}
function step(id: string, action: string, phase: "setup" | "scenario" | "cleanup" = "scenario"): {
  id: string; action: string; phase: "setup" | "scenario" | "cleanup"; stepIndex: number; expectedResult: string | null; status: string;
} {
  return { id, action, phase, stepIndex: Number(id.slice(1)), expectedResult: null, status: "queued" };
}
function prime(input: { browser?: boolean; connections?: unknown[]; steps?: ReturnType<typeof step>[]; screenshotPolicy?: string } = {}) {
  store.markRunStarted.mockResolvedValue(true);
  store.markCaseStarted.mockResolvedValue(true);
  store.markStepStarted.mockResolvedValue(true);
  store.finishRun.mockResolvedValue(true);
  store.finishCase.mockResolvedValue(true);
  store.finishStep.mockResolvedValue(true);
  store.incrementCompletedCases.mockResolvedValue(true);
  store.skipRemainingQueuedSteps.mockResolvedValue(true);
  store.recordStepToolCall.mockResolvedValue(true);
  store.isRunCancellationRequested.mockResolvedValue(false);
  store.executionRunSettings.mockResolvedValue({ browserEnabled: input.browser ?? false, baseUrl: input.browser ? "https://app.example.com/start" : null,
    executionNotes: null, screenshotPolicy: input.screenshotPolicy ?? "none", headless: true, viewportWidth: 1280, viewportHeight: 720 });
  store.executionConfigSnapshot.mockResolvedValue(input.browser ? { transport: "stdio", endpoint: null, artifactBaseUrl: null } : {});
  store.casesForRun.mockResolvedValue([{ id: "c1", azureTestCaseId: null, status: "queued" }]);
  store.stepsForCase.mockResolvedValue(input.steps ?? [step("s1", "Read API")]);
  deps.testData.mockResolvedValue([{ title: "Password", value: "test-secret", isSecret: true }]);
  deps.connections.mockResolvedValue(input.connections ?? [apiConnection()]);
  deps.mcpConfig.mockResolvedValue({ status: "configured", transport: "stdio", endpoint: null, artifactBaseUrl: null });
  const callTool = vi.fn(async (_name: string) => ({ content: [{ type: "text", text: "Browser evidence" }] }));
  deps.connectMcp.mockResolvedValue({ tools: { callTool, listOpenTabs: vi.fn(async () => ["https://app.example.com/start"]), toolDefinitions: [{ name: "browser_snapshot", description: "Snapshot", inputSchema: { type: "object" } }] }, close: vi.fn(async () => undefined) });
  deps.startOperation.mockImplementation(async () => `op-${deps.startOperation.mock.calls.length}`);
  deps.finishOperation.mockResolvedValue(true);
  deps.apiExecute.mockResolvedValue({ statusCode: 200, statusText: "OK", body: { id: 42 }, contentType: "application/json", truncated: false, durationMs: 1 });
  deps.databaseDiscover.mockResolvedValue({ objects: [{ schema: "public", table: "accounts", columns: [{ name: "id", dataType: "int" }] }], truncated: false });
  deps.databaseExecute.mockResolvedValue({ status: "ok", command: "SELECT", rowCount: 1, columns: ["id"], rows: [{ id: 42 }], safeRows: [{ id: "[REDACTED]" }], truncated: false, durationMs: 1 });
  deps.openApi.mockResolvedValue([]);
  deps.importArtifact.mockResolvedValue([]);
  return { callTool };
}

describe("mixed execution job", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("runs a browserless API case without Playwright MCP or Azure PAT, keeping credentials out of model input", async () => {
    prime({ steps: [step("s1", "Read API using api-secret and test-secret")] });
    deps.mixedAgent.mockImplementation(async (input: { executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>; aliases: unknown[] }) => {
      expect(JSON.stringify(input)).not.toContain("api-secret");
      expect(JSON.stringify(input)).not.toContain("test-secret");
      await input.executeTool("api_request", { alias: "service", method: "GET", path: "/accounts" });
      return { outcome: "passed", summary: "verified", turns: 1 };
    });
    await expect(runPlaywrightExecutionJob(job, context())).resolves.toMatchObject({ outcome: "passed", completedCases: 1 });
    expect(deps.mcpConfig).not.toHaveBeenCalled();
    expect(deps.connectMcp).not.toHaveBeenCalled();
    expect(deps.apiExecute).toHaveBeenCalledTimes(1);
    expect(store.finishRun).toHaveBeenCalledWith("r", "passed", null, ["test-secret", "api-secret"], "worker");
  });

  it("preserves authored API, DB, UI order and navigates only when browser work begins", async () => {
    const { callTool } = prime({ browser: true, connections: [apiConnection(), dbConnection()], steps: [
      step("s1", "Create API data", "setup"), step("s2", "Verify in DB", "scenario"), step("s3", "Inspect UI", "scenario"),
    ] });
    const events: string[] = [];
    deps.apiExecute.mockImplementation(async () => { events.push("api"); return { statusCode: 200, statusText: "OK", body: {}, contentType: "application/json", truncated: false, durationMs: 1 }; });
    deps.databaseExecute.mockImplementation(async () => { events.push("db"); return { status: "ok", command: "SELECT", rowCount: 1, columns: [], rows: [], safeRows: [], truncated: false, durationMs: 1 }; });
    callTool.mockImplementation(async (name: string) => { events.push(name); return { content: [] }; });
    deps.mixedAgent.mockImplementation(async (input: { action: string; executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) => {
      if (input.action === "Create API data") await input.executeTool("api_request", { alias: "service", method: "GET", path: "/data" });
      if (input.action === "Verify in DB") await input.executeTool("database_query", { alias: "records", kind: "select", sql: "SELECT id FROM public.accounts", parameters: {} });
      if (input.action === "Inspect UI") await input.executeTool("browser_snapshot", {});
      return { outcome: "passed", summary: "ok", turns: 1 };
    });
    await expect(runPlaywrightExecutionJob(job, context())).resolves.toMatchObject({ outcome: "passed" });
    expect(events).toEqual(["api", "db", "browser_navigate", "browser_resize", "browser_snapshot"]);
    expect(deps.connectMcp).toHaveBeenCalledWith(expect.objectContaining({ transport: "stdio" }), { headless: true });
  });

  it("uses worker-only API response capture across steps without exposing it to model or operation evidence", async () => {
    prime({ steps: [step("s1", "Get session"), step("s2", "Use session")] });
    deps.apiExecute.mockResolvedValue({ statusCode: 200, statusText: "OK", body: { session_token: "[REDACTED]" },
      rawBody: { session_token: "private-session-token" }, contentType: "application/json", truncated: false, durationMs: 1 });
    deps.mixedAgent.mockImplementation(async (input: { action: string; executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) => {
      expect(JSON.stringify(input)).not.toContain("private-session-token");
      if (input.action === "Get session") {
        await input.executeTool("api_request", { alias: "service", method: "GET", path: "/session" });
        await input.executeTool("capture_value", { name: "session_token", path: "body.session_token" });
      } else {
        await input.executeTool("api_request", { alias: "service", method: "GET", path: "/session/{{capture:session_token}}" });
      }
      return { outcome: "passed", summary: "ok", turns: 1 };
    });
    await runPlaywrightExecutionJob(job, context());
    expect(deps.apiExecute.mock.calls[1]?.[0]).toMatchObject({ path: "/session/private-session-token" });
    expect(JSON.stringify(deps.finishOperation.mock.calls.map((call) => call[0].evidence))).not.toContain("private-session-token");
    expect(JSON.stringify(store.recordStepToolCall.mock.calls.map((call) => [call[2], call[3]]))).not.toContain("private-session-token");
  });

  it("redacts secrets in API observation fields before they reach the model", async () => {
    prime();
    deps.apiExecute.mockResolvedValue({ statusCode: 200, statusText: "test-secret", body: { "test-secret": "visible" },
      contentType: "test-secret", truncated: false, durationMs: 1 });
    deps.mixedAgent.mockImplementation(async (input: { executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) => {
      const result = await input.executeTool("api_request", { alias: "service", method: "GET", path: "/accounts" });
      expect(JSON.stringify(result)).not.toContain("test-secret");
      return { outcome: "passed", summary: "ok", turns: 1 };
    });
    await expect(runPlaywrightExecutionJob(job, context())).resolves.toMatchObject({ outcome: "passed" });
  });

  it("canonicalizes mixed-case discovered table names in the runner allowlist", async () => {
    prime({ connections: [dbConnection()] });
    deps.databaseDiscover.mockResolvedValue({ objects: [{ schema: "DbO", table: "Orders", columns: [] }], truncated: false });
    deps.mixedAgent.mockImplementation(async (input: { executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) => {
      await input.executeTool("database_schema", { alias: "records" });
      return { outcome: "passed", summary: "ok", turns: 1 };
    });
    await runPlaywrightExecutionJob(job, context());
    expect(deps.setDatabaseAccess).toHaveBeenCalledWith({ schemas: ["DbO"], tables: new Set(["dbo.orders"]) });
  });

  it("still captures validation screenshots and redacts secret values from persisted tool evidence", async () => {
    const { callTool } = prime({ browser: true, screenshotPolicy: "validation-points", steps: [{ ...step("s1", "Inspect UI"), expectedResult: "Visible" }] });
    callTool.mockImplementation(async (name: string) => ({ content: [{ type: "text", text: name === "browser_snapshot" ? "test-secret visible" : "evidence" }] }));
    deps.mixedAgent.mockImplementation(async (input: { executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) => {
      await input.executeTool("browser_snapshot", {});
      return { outcome: "passed", summary: "ok", turns: 1 };
    });
    await runPlaywrightExecutionJob(job, context());
    expect(callTool.mock.calls.map((call) => call[0])).toEqual(["browser_navigate", "browser_resize", "browser_snapshot", "browser_take_screenshot"]);
    const persisted = store.recordStepToolCall.mock.calls[0];
    expect(JSON.stringify(persisted?.[3])).not.toContain("test-secret");
    expect(deps.importArtifact).toHaveBeenCalledWith(expect.objectContaining({ toolName: "browser_take_screenshot" }));
  });

  it("runs remaining cleanup after a scenario failure and skips later normal steps", async () => {
    prime({ steps: [step("s1", "Fail"), step("s2", "Skip"), step("s3", "Cleanup", "cleanup")] });
    deps.mixedAgent.mockImplementation(async (input: { action: string }) => ({ outcome: input.action === "Fail" ? "failed" : "passed", summary: input.action, turns: 1 }));
    await runPlaywrightExecutionJob(job, context());
    expect(deps.mixedAgent.mock.calls.map((call) => call[0].action)).toEqual(["Fail", "Cleanup"]);
    expect(store.finishCase).toHaveBeenCalledWith("c1", "failed", "Fail", expect.any(Array), "worker");
  });

  it("runs cleanup after cancellation with a fresh signal", async () => {
    prime({ steps: [step("s1", "Work"), step("s2", "Cleanup", "cleanup")] });
    const controller = new AbortController();
    deps.mixedAgent.mockImplementation(async (input: { action: string; signal: AbortSignal }) => {
      if (input.action === "Work") { controller.abort(new Error("cancelled")); return { outcome: "cancelled", summary: "cancelled", turns: 1 }; }
      expect(input.signal.aborted).toBe(false);
      return { outcome: "passed", summary: "cleaned", turns: 1 };
    });
    const result = await runPlaywrightExecutionJob(job, { workerId: "worker", signal: controller.signal, updateProgress: vi.fn(async () => undefined) } as never);
    expect(result).toMatchObject({ outcome: "cancelled" });
    expect(deps.mixedAgent.mock.calls.map((call) => call[0].action)).toEqual(["Work", "Cleanup"]);
  });

  it("bounds the whole remaining cleanup phase to 60 seconds", async () => {
    prime({ steps: [step("s1", "Fail"), step("s2", "Cleanup", "cleanup"), step("s3", "More cleanup", "cleanup")] });
    const originalTimeout = global.setTimeout;
    vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === 60_000) { queueMicrotask(() => callback(...args)); return 1 as never; }
      return originalTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    deps.mixedAgent.mockImplementation(async (input: { action: string; signal: AbortSignal }) => {
      if (input.action === "Fail") return { outcome: "failed", summary: "failed", turns: 1 };
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { outcome: "cancelled", summary: "cancelled", turns: 1 };
    });
    await runPlaywrightExecutionJob(job, context());
    expect(deps.mixedAgent.mock.calls.map((call) => call[0].action)).toEqual(["Fail", "Cleanup"]);
    expect(store.finishStep).toHaveBeenCalledWith("s2", "timeout", "Cleanup exceeded 60 seconds.", expect.any(Array), "worker");
  });

  it("refuses external dispatch when worker loses ownership", async () => {
    prime();
    deps.startOperation.mockResolvedValueOnce(null);
    deps.mixedAgent.mockImplementation(async (input: { executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown> }) => {
      await input.executeTool("api_request", { alias: "service", method: "GET", path: "/accounts" });
      return { outcome: "passed", summary: "ok", turns: 1 };
    });
    await expect(runPlaywrightExecutionJob(job, context())).rejects.toThrow(/no longer owns/);
    expect(deps.apiExecute).not.toHaveBeenCalled();
  });
});
