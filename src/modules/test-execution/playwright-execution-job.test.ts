import { describe, expect, it, vi } from "vitest";

const markRunStarted = vi.fn();
const finishRun = vi.fn();
vi.mock("@/modules/credentials/credential.service", () => ({ resolveUserAzurePat: vi.fn(), resolveUserLlmConfig: vi.fn() }));
vi.mock("@/modules/integrations/provider-registry", () => ({ createIntegrationProvider: vi.fn(), resolveWorkspaceProviderId: vi.fn() }));
vi.mock("@/modules/llm/llm-defaults", () => ({ DEFAULT_RETRY_ATTEMPTS: 1, getMaxOutputTokenCapDefaultFromEnv: vi.fn() }));
vi.mock("@/modules/llm/llm-provider.factory", () => ({ createLLMProvider: vi.fn() }));
vi.mock("@/modules/workspace/workspace.service", () => ({ getWorkspaceById: vi.fn() }));
vi.mock("@/modules/workspace/workspace-settings.service", () => ({ getWorkspaceSettings: vi.fn() }));
vi.mock("./execution-store.service", () => ({
  markRunStarted: (...a: unknown[]) => markRunStarted(...a), finishRun: (...a: unknown[]) => finishRun(...a),
  casesForRun: vi.fn(), executionConfigSnapshot: vi.fn(), finishCase: vi.fn(), finishStep: vi.fn(), incrementCompletedCases: vi.fn(),
  isRunCancellationRequested: vi.fn(), markCaseStarted: vi.fn(), recordStepToolCall: vi.fn(), stepsForCase: vi.fn(),
}));
vi.mock("./playwright-agent", () => ({ executeTestStepWithAgent: vi.fn() }));
vi.mock("./playwright-mcp-client", () => ({ connectPlaywrightMcp: vi.fn() }));
vi.mock("./playwright-mcp-config.service", () => ({ resolvePlaywrightMcpConfig: vi.fn() }));
vi.mock("./execution-artifact.service", () => ({ artifactUrls: vi.fn(), importHttpArtifact: vi.fn(), importInlineMcpArtifacts: vi.fn() }));

import { runPlaywrightExecutionJob } from "./playwright-execution-job";

describe("Playwright execution job terminalization", () => {
  it("attempts to terminalize the run when starting it fails", async () => {
    markRunStarted.mockRejectedValue(new Error("database write failed"));
    await expect(runPlaywrightExecutionJob({ workspaceId: "w", payload: { runId: "r", userId: "u", scope: { projectId: "p", azureProjectId: "ap" } } } as never, { signal: new AbortController().signal, updateProgress: vi.fn() } as never)).rejects.toThrow("database write failed");
    expect(finishRun).toHaveBeenCalledWith("r", "error", "database write failed");
  });
});
