import { beforeEach, describe, expect, it, vi } from "vitest";

const requireWorkflowContext = vi.fn();
const resolveProjectScope = vi.fn();
const getSummary = vi.fn();
const resolveConfig = vi.fn();
const hasHealthyWorkerCapability = vi.fn();
const getUserAzureAdapter = vi.fn();
const createExecutionRun = vi.fn();

vi.mock("@/modules/credentials/scoped-resolution.service", () => ({
  requireWorkflowContext: (...args: unknown[]) => requireWorkflowContext(...args),
  getUserAzureAdapter: (...args: unknown[]) => getUserAzureAdapter(...args),
  authErrorResponse: () => null,
}));
vi.mock("@/modules/projects/workspace-projects.service", () => ({ resolveProjectScope: (...args: unknown[]) => resolveProjectScope(...args) }));
vi.mock("@/modules/test-execution/playwright-mcp-config.service", () => ({ getPlaywrightMcpConfigSummary: (...args: unknown[]) => getSummary(...args), resolvePlaywrightMcpConfig: (...args: unknown[]) => resolveConfig(...args) }));
vi.mock("@/modules/jobs/worker-registry.service", () => ({ hasHealthyWorkerCapability: (...args: unknown[]) => hasHealthyWorkerCapability(...args) }));
vi.mock("@/modules/test-execution/execution-store.service", () => ({ createExecutionRun: (...args: unknown[]) => createExecutionRun(...args) }));

import { POST } from "./route";

const scope = { workspaceId: "w", projectId: "p", azureProjectId: "ap", azureProjectName: "P", azureOrganizationUrl: "https://dev.azure.com/o" };

beforeEach(() => {
  vi.resetAllMocks();
  requireWorkflowContext.mockResolvedValue({ userId: "u", workspace: { id: "w" } });
  resolveProjectScope.mockResolvedValue(scope);
  getSummary.mockResolvedValue({ status: "configured", transport: "http", endpoint: "https://mcp.example/mcp", artifactBaseUrl: null });
  resolveConfig.mockResolvedValue({ status: "configured", transport: "http", endpoint: "https://mcp.example/mcp", artifactBaseUrl: null, bearerToken: null });
  hasHealthyWorkerCapability.mockResolvedValue(false);
});

describe("Playwright execution start", () => {
  it("fails before Azure reads when no compatible worker is healthy", async () => {
    const request = new Request("http://local", { method: "POST", body: JSON.stringify({ scope, testPlanId: 1, testSuiteId: 2 }) });
    const response = await POST(request);
    expect(response.status).toBe(503);
    expect(hasHealthyWorkerCapability).toHaveBeenCalledWith("playwright_mcp_execution");
    expect(getUserAzureAdapter).not.toHaveBeenCalled();
    expect(createExecutionRun).not.toHaveBeenCalled();
  });

  it("revalidates stored transport policy before Azure reads or enqueue", async () => {
    hasHealthyWorkerCapability.mockResolvedValue(true);
    resolveConfig.mockRejectedValue(new Error("Stored Playwright MCP HTTP origin is no longer allowed by deployment policy."));
    const request = new Request("http://local", { method: "POST", body: JSON.stringify({ scope, testPlanId: 1, testSuiteId: 2 }) });
    await POST(request);
    expect(resolveConfig).toHaveBeenCalledWith("w");
    expect(getUserAzureAdapter).not.toHaveBeenCalled();
    expect(createExecutionRun).not.toHaveBeenCalled();
  });
});
