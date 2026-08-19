import { beforeEach, describe, expect, it, vi } from "vitest";

type AgentInput = {
  onEvent?: (event: unknown) => Promise<void> | void;
  runContext?: unknown;
};

type InlineImportInput = {
  toolName: string;
  persistInlineScreenshots?: boolean;
};

const markRunStarted = vi.fn();
const finishRun = vi.fn();
const finishStep = vi.fn();
const finishCase = vi.fn();
const casesForRun = vi.fn();
const stepsForCase = vi.fn();
const markStepStarted = vi.fn();
const skipRemainingQueuedSteps = vi.fn();
const executionConfigSnapshot = vi.fn();
const executionRunSettings = vi.fn();
const decryptedRunTestData = vi.fn();
const executeTestStepWithAgent = vi.fn<(input: AgentInput) => Promise<{ outcome: string; summary: string }>>();
const validateToolArguments = vi.fn(async (_name: string, args: unknown) => args);
const connectPlaywrightMcp = vi.fn();
const resolvePlaywrightMcpConfig = vi.fn();
const importInlineMcpArtifacts = vi.fn<(input: InlineImportInput) => Promise<string[]>>();
const recordStepToolCall = vi.fn();

vi.mock("@/modules/credentials/credential.service", () => ({ resolveUserAzurePat: vi.fn(async () => "pat"), resolveUserLlmConfig: vi.fn(async () => ({})) }));
vi.mock("@/modules/integrations/provider-registry", () => ({
  createIntegrationProvider: vi.fn(() => ({ testConnection: vi.fn() })),
  resolveWorkspaceProviderId: vi.fn(() => "azure-devops"),
}));
vi.mock("@/modules/llm/llm-defaults", () => ({ DEFAULT_RETRY_ATTEMPTS: 1, getMaxOutputTokenCapDefaultFromEnv: vi.fn() }));
vi.mock("@/modules/llm/llm-provider.factory", () => ({ createLLMProvider: vi.fn(() => ({})) }));
vi.mock("@/modules/workspace/workspace.service", () => ({ getWorkspaceById: vi.fn(async () => ({ id: "w", azureOrgUrl: "https://dev.azure.com/o" })) }));
vi.mock("@/modules/workspace/workspace-settings.service", () => ({ getWorkspaceSettings: vi.fn(async () => null) }));
vi.mock("./execution-store.service", () => ({
  markRunStarted: (...a: unknown[]) => markRunStarted(...a), finishRun: (...a: unknown[]) => finishRun(...a),
  casesForRun: (...a: unknown[]) => casesForRun(...a), executionConfigSnapshot: (...a: unknown[]) => executionConfigSnapshot(...a),
  executionRunSettings: (...a: unknown[]) => executionRunSettings(...a),
  finishCase: (...a: unknown[]) => finishCase(...a), finishStep: (...a: unknown[]) => finishStep(...a),
  incrementCompletedCases: vi.fn(),
  isRunCancellationRequested: vi.fn(async () => false), markCaseStarted: vi.fn(),
  markStepStarted: (...a: unknown[]) => markStepStarted(...a),
  skipRemainingQueuedSteps: (...a: unknown[]) => skipRemainingQueuedSteps(...a),
  recordStepToolCall: (...a: unknown[]) => recordStepToolCall(...a), stepsForCase: (...a: unknown[]) => stepsForCase(...a),
}));
vi.mock("./execution-test-data.service", () => ({ decryptedRunTestData: (...a: unknown[]) => decryptedRunTestData(...a) }));
vi.mock("./playwright-agent", () => ({
  createPlaywrightToolPolicy: vi.fn(() => ({ transport: "stdio", allowAllOrigins: false, allowedNavigationOrigins: new Set(["https://app.example.com"]), uploadRoots: [] })),
  validatePlaywrightToolArguments: (name: string, args: unknown) => validateToolArguments(name, args),
  executeTestStepWithAgent: (input: AgentInput) => executeTestStepWithAgent(input),
}));
vi.mock("./playwright-mcp-client", () => ({ connectPlaywrightMcp: (...a: unknown[]) => connectPlaywrightMcp(...a) }));
vi.mock("./playwright-mcp-config.service", () => ({ resolvePlaywrightMcpConfig: (...a: unknown[]) => resolvePlaywrightMcpConfig(...a) }));
vi.mock("./execution-artifact.service", () => ({
  artifactUrls: vi.fn(() => []),
  importHttpArtifact: vi.fn(),
  importInlineMcpArtifacts: (input: InlineImportInput) => importInlineMcpArtifacts(input),
}));

import { runPlaywrightExecutionJob } from "./playwright-execution-job";

const job = { workspaceId: "w", payload: { runId: "r", userId: "u", scope: { projectId: "p", azureProjectId: "ap" } } } as never;

function jobContext() {
  return { signal: new AbortController().signal, updateProgress: vi.fn() } as never;
}

function primeHappyRun(input: { screenshotPolicy: string; agentOutcomes: Array<{ outcome: string; summary: string }>; headless?: boolean; viewportWidth?: number; viewportHeight?: number }) {
  const callTool = vi.fn(async (..._args: unknown[]) => ({ content: [] as unknown[] }));
  resolvePlaywrightMcpConfig.mockResolvedValue({ status: "configured", transport: "stdio", endpoint: null, artifactBaseUrl: null, bearerToken: null });
  // jsonb round-trips reorder object keys — the mock mimics that so a regression
  // to stringify-equality drift checking fails here.
  executionConfigSnapshot.mockResolvedValue({ artifactBaseUrl: null, endpoint: null, transport: "stdio" });
  executionRunSettings.mockResolvedValue({
    baseUrl: "https://app.example.com/start", executionNotes: "Use staging.", screenshotPolicy: input.screenshotPolicy,
    headless: input.headless ?? true, viewportWidth: input.viewportWidth ?? 1920, viewportHeight: input.viewportHeight ?? 1080,
  });
  decryptedRunTestData.mockResolvedValue([
    { title: "Username", value: "qa@example.com", isSecret: false },
    { title: "Password", value: "S3cret!Value", isSecret: true },
  ]);
  casesForRun.mockResolvedValue([{ id: "c1", azureTestCaseId: 1, azureTestPointId: null, azurePlanId: null, azureSuiteId: null, title: "Case", status: "queued" }]);
  stepsForCase.mockResolvedValue([
    { id: "s1", stepIndex: 0, action: "Open the app", expectedResult: "It loads", status: "queued" },
    { id: "s2", stepIndex: 1, action: "Click", expectedResult: null, status: "queued" },
  ]);
  connectPlaywrightMcp.mockResolvedValue({ tools: { callTool, listOpenTabs: vi.fn(async () => []) }, close: vi.fn(async () => undefined) });
  const outcomes = [...input.agentOutcomes];
  executeTestStepWithAgent.mockImplementation(async () => outcomes.shift() ?? { outcome: "passed", summary: "ok" });
  return { callTool };
}

describe("Playwright execution job", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateToolArguments.mockImplementation(async (_name: string, args: unknown) => args);
  });

  it("attempts to terminalize the run when starting it fails", async () => {
    markRunStarted.mockRejectedValueOnce(new Error("database write failed"));
    await expect(runPlaywrightExecutionJob(job, jobContext())).rejects.toThrow("database write failed");
    expect(finishRun).toHaveBeenCalledWith("r", "error", "database write failed");
  });

  it("fails the run when the transport configuration actually changed after queueing", async () => {
    primeHappyRun({ screenshotPolicy: "validation-points", agentOutcomes: [] });
    executionConfigSnapshot.mockResolvedValue({ artifactBaseUrl: null, endpoint: "https://old.example/mcp", transport: "http" });
    await expect(runPlaywrightExecutionJob(job, jobContext())).rejects.toThrow(/configuration changed/);
    expect(casesForRun).not.toHaveBeenCalled();
  });

  it("navigates to the base URL, then sizes the viewport, and captures policy-driven screenshots with secret-aware persistence", async () => {
    const { callTool } = primeHappyRun({
      screenshotPolicy: "validation-points",
      agentOutcomes: [{ outcome: "passed", summary: "ok" }, { outcome: "failed", summary: "button missing" }],
    });
    await runPlaywrightExecutionJob(job, jobContext());

    expect(connectPlaywrightMcp).toHaveBeenCalledWith(expect.objectContaining({ transport: "stdio" }), { headless: true });
    expect(callTool.mock.calls[0]).toEqual(["browser_navigate", { url: "https://app.example.com/start" }, expect.anything()]);
    // Resize comes after navigation — some MCP servers reject it on a tabless browser.
    expect(callTool.mock.calls[1]).toEqual(["browser_resize", { width: 1920, height: 1080 }, expect.anything()]);
    const screenshotCalls = callTool.mock.calls.filter((call) => call[0] === "browser_take_screenshot");
    expect(screenshotCalls).toHaveLength(2); // validation point (s1 passed w/ expected) + failure evidence (s2)

    const agentInput = executeTestStepWithAgent.mock.calls[0]?.[0];
    expect(agentInput?.runContext).toEqual({
      baseUrl: "https://app.example.com/start",
      executionNotes: "Use staging.",
      testData: [
        { title: "Username", value: "qa@example.com" },
        { title: "Password", value: "S3cret!Value" },
      ],
    });

    expect(finishStep).toHaveBeenCalledWith("s1", "passed", null, ["S3cret!Value"]);
    expect(finishCase).toHaveBeenCalledWith("c1", "failed", "button missing", ["S3cret!Value"]);
    // Each executed step is explicitly marked running before the agent works on it,
    // and the failing case terminalizes any steps it never reached.
    expect(markStepStarted.mock.calls.map((call) => call[0])).toEqual(["s1", "s2"]);
    expect(skipRemainingQueuedSteps).toHaveBeenCalledWith("c1");
    const screenshotImports = importInlineMcpArtifacts.mock.calls.filter((call) => call[0].toolName === "browser_take_screenshot");
    expect(screenshotImports).toHaveLength(2);
    expect(finishRun).toHaveBeenCalledWith("r", "failed", "One or more test cases did not pass.", ["S3cret!Value"]);
  });

  it("suppresses all screenshot persistence under the none policy", async () => {
    const { callTool } = primeHappyRun({ screenshotPolicy: "none", agentOutcomes: [] });
    executeTestStepWithAgent.mockImplementation(async (input) => {
      await input.onEvent?.({ kind: "tool_call", toolName: "browser_click", arguments: {}, result: { content: [{ type: "image", data: "aGk=" }] } });
      return { outcome: "failed", summary: "broken" };
    });
    await runPlaywrightExecutionJob(job, jobContext());

    expect(callTool.mock.calls.filter((call) => call[0] === "browser_take_screenshot")).toHaveLength(0);
    const inlineImport = importInlineMcpArtifacts.mock.calls[0]?.[0];
    expect(inlineImport?.persistInlineScreenshots).toBe(false);
  });

  it("threads the headed choice and custom viewport into the browser session", async () => {
    const { callTool } = primeHappyRun({
      screenshotPolicy: "validation-points", agentOutcomes: [],
      headless: false, viewportWidth: 1280, viewportHeight: 720,
    });
    await runPlaywrightExecutionJob(job, jobContext());
    expect(connectPlaywrightMcp).toHaveBeenCalledWith(expect.anything(), { headless: false });
    expect(callTool.mock.calls[1]).toEqual(["browser_resize", { width: 1280, height: 720 }, expect.anything()]);
  });

  it("skips the viewport resize when the base navigation fails", async () => {
    const { callTool } = primeHappyRun({ screenshotPolicy: "validation-points", agentOutcomes: [] });
    validateToolArguments.mockRejectedValueOnce(new Error("Playwright navigation URL is not on an allowed origin."));
    await runPlaywrightExecutionJob(job, jobContext());
    expect(callTool.mock.calls.filter((call) => call[0] === "browser_resize")).toHaveLength(0);
  });

  it("skips remaining queued steps when the first step throws a schema-validation error", async () => {
    primeHappyRun({ screenshotPolicy: "none", agentOutcomes: [] });
    executeTestStepWithAgent.mockRejectedValueOnce(new Error(
      "LLM output failed schema validation for PlaywrightAgentDecision: invalid_union_discriminator",
    ));
    await runPlaywrightExecutionJob(job, jobContext());
    expect(executeTestStepWithAgent).toHaveBeenCalledTimes(1);
    expect(finishStep).toHaveBeenCalledWith(
      "s1",
      "error",
      expect.stringContaining("PlaywrightAgentDecision"),
      ["S3cret!Value"],
    );
    expect(skipRemainingQueuedSteps).toHaveBeenCalledWith("c1");
    expect(finishCase).toHaveBeenCalledWith(
      "c1",
      "error",
      expect.stringContaining("PlaywrightAgentDecision"),
      ["S3cret!Value"],
    );
  });

  it("fails the case with a friendly error when the base URL is not allowed, without running any step", async () => {
    primeHappyRun({ screenshotPolicy: "validation-points", agentOutcomes: [] });
    validateToolArguments.mockRejectedValueOnce(new Error("Playwright navigation URL is not on an allowed origin."));
    await runPlaywrightExecutionJob(job, jobContext());
    expect(executeTestStepWithAgent).not.toHaveBeenCalled();
    expect(markStepStarted).not.toHaveBeenCalled();
    expect(skipRemainingQueuedSteps).toHaveBeenCalledWith("c1");
    expect(finishCase).toHaveBeenCalledWith("c1", "error", expect.stringContaining("The Base URL is not on an allowed test origin for this deployment."), expect.anything());
  });
});
